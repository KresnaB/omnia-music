package player

import (
	"context"
	"fmt"
	"math/rand"
	"sync"
	"time"

	"github.com/bwmarrin/discordgo"
	"github.com/jonas747/dca"

	"omnia-music/internal/config"
	"omnia-music/internal/media"
)

type LoopMode string

const (
	LoopOff   LoopMode = "off"
	LoopTrack LoopMode = "track"
	LoopQueue LoopMode = "queue"
)

type GuildPlayer struct {
	mu sync.Mutex

	cfg       *config.Config
	session   *discordgo.Session
	resolver  *media.Resolver
	lyrics    *media.LyricsClient
	guildID   string
	channelID string
	voice     *discordgo.VoiceConnection

	queue   []*media.TrackInfo
	current *media.TrackInfo
	history []*media.TrackInfo

	paused   bool
	loopMode LoopMode
	autoplay bool

	sleepUntil *time.Time
	idleTimer  *time.Timer
	playID     int64
	streamer   *dca.StreamingSession
	encoder    *dca.EncodeSession
}

type Status struct {
	Connected  bool
	ChannelID  string
	QueueSize  int
	Paused     bool
	LoopMode   LoopMode
	Autoplay   bool
	Current    *media.TrackInfo
	SleepUntil *time.Time
}

func NewGuildPlayer(cfg *config.Config, s *discordgo.Session, resolver *media.Resolver, lyrics *media.LyricsClient, guildID string) *GuildPlayer {
	return &GuildPlayer{
		cfg:      cfg,
		session:  s,
		resolver: resolver,
		lyrics:   lyrics,
		guildID:  guildID,
		loopMode: LoopOff,
	}
}

func (p *GuildPlayer) Enqueue(ctx context.Context, voiceChannelID, query, requestedBy, requestedByID string) (*media.TrackInfo, error) {
	track, err := p.resolver.Resolve(ctx, query)
	if err != nil {
		return nil, err
	}

	track.RequestedBy = requestedBy
	track.RequestedByID = requestedByID

	p.mu.Lock()
	defer p.mu.Unlock()

	if err := p.ensureVoiceLocked(voiceChannelID); err != nil {
		return nil, err
	}

	p.queue = append(p.queue, track)
	p.channelID = voiceChannelID
	p.bumpIdleTimerLocked()

	if p.current == nil {
		go p.playLoop()
	}

	return track, nil
}

func (p *GuildPlayer) TogglePause() (bool, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current == nil {
		return false, fmt.Errorf("tidak ada lagu yang sedang diputar")
	}
	p.paused = !p.paused
	if p.streamer != nil {
		p.streamer.SetPaused(p.paused)
	}
	return p.paused, nil
}

func (p *GuildPlayer) Skip() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current == nil {
		return fmt.Errorf("tidak ada lagu yang sedang diputar")
	}
	p.playID++
	return nil
}

func (p *GuildPlayer) Stop() error {
	p.mu.Lock()
	defer p.mu.Unlock()

	p.playID++
	p.queue = nil
	p.current = nil
	p.history = nil
	p.paused = false
	if p.encoder != nil {
		p.encoder.Cleanup()
		p.encoder = nil
	}
	if p.streamer != nil {
		p.streamer.SetPaused(true)
		p.streamer = nil
	}

	if p.voice != nil {
		err := p.voice.Disconnect()
		p.voice = nil
		return err
	}
	return nil
}

func (p *GuildPlayer) Reconnect(voiceChannelID string) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.voice != nil {
		_ = p.voice.Disconnect()
		p.voice = nil
	}
	return p.ensureVoiceLocked(voiceChannelID)
}

func (p *GuildPlayer) Seek(position time.Duration) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.current == nil {
		return fmt.Errorf("tidak ada lagu yang sedang diputar")
	}
	if position < 0 {
		position = 0
	}
	p.current.Offset = position
	p.playID++
	if p.encoder != nil {
		p.encoder.Cleanup()
	}
	return nil
}

func (p *GuildPlayer) Shuffle() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	rand.Shuffle(len(p.queue), func(i, j int) {
		p.queue[i], p.queue[j] = p.queue[j], p.queue[i]
	})
	return len(p.queue)
}

func (p *GuildPlayer) Move(from, to int) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	if from < 1 || from > len(p.queue) || to < 1 || to > len(p.queue) {
		return fmt.Errorf("posisi queue tidak valid")
	}
	if from == to {
		return nil
	}

	item := p.queue[from-1]
	p.queue = append(p.queue[:from-1], p.queue[from:]...)

	if from < to {
		to--
	}

	head := append([]*media.TrackInfo{}, p.queue[:to-1]...)
	head = append(head, item)
	p.queue = append(head, p.queue[to-1:]...)
	return nil
}

func (p *GuildPlayer) SetLoopMode(mode LoopMode) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.loopMode = mode
}

func (p *GuildPlayer) ToggleAutoplay() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.autoplay = !p.autoplay
	return p.autoplay
}

func (p *GuildPlayer) SetSleep(delay time.Duration) *time.Time {
	when := time.Now().Add(delay)
	p.mu.Lock()
	defer p.mu.Unlock()
	p.sleepUntil = &when
	return p.sleepUntil
}

func (p *GuildPlayer) QueueSnapshot() ([]*media.TrackInfo, *media.TrackInfo) {
	p.mu.Lock()
	defer p.mu.Unlock()

	queue := make([]*media.TrackInfo, len(p.queue))
	copy(queue, p.queue)
	return queue, p.current
}

func (p *GuildPlayer) Status() Status {
	p.mu.Lock()
	defer p.mu.Unlock()

	return Status{
		Connected:  p.voice != nil,
		ChannelID:  p.channelID,
		QueueSize:  len(p.queue),
		Paused:     p.paused,
		LoopMode:   p.loopMode,
		Autoplay:   p.autoplay,
		Current:    p.current,
		SleepUntil: p.sleepUntil,
	}
}

func (p *GuildPlayer) FetchLyrics(ctx context.Context) (*media.LyricsResult, error) {
	p.mu.Lock()
	current := p.current
	p.mu.Unlock()

	if current == nil {
		return nil, fmt.Errorf("tidak ada lagu yang sedang diputar")
	}
	return p.lyrics.Search(ctx, current.Title, current.Uploader)
}

func (p *GuildPlayer) playLoop() {
	for {
		track, playID, disconnect := p.nextTrack()
		if disconnect {
			_ = p.Stop()
			return
		}
		if track == nil {
			return
		}

		_ = p.streamTrack(track, playID)

		if p.shouldSleep() {
			_ = p.Stop()
			return
		}
	}
}

func (p *GuildPlayer) nextTrack() (*media.TrackInfo, int64, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if len(p.queue) == 0 && p.autoplay && len(p.history) > 0 {
		last := p.history[len(p.history)-1]
		autoTrack, err := p.resolver.Resolve(context.Background(), last.Title+" audio")
		if err == nil {
			autoTrack.RequestedBy = "Autoplay"
			autoTrack.RequestedByID = "autoplay"
			p.queue = append(p.queue, autoTrack)
		}
	}

	if len(p.queue) == 0 {
		p.current = nil
		p.bumpIdleTimerLocked()
		return nil, 0, true
	}

	p.current = p.queue[0]
	p.queue = p.queue[1:]
	p.paused = false
	p.playID++
	playID := p.playID
	p.bumpIdleTimerLocked()
	return p.current, playID, false
}

func (p *GuildPlayer) streamTrack(track *media.TrackInfo, playID int64) error {
	enc, err := p.encode(track)
	if err != nil {
		return err
	}
	defer enc.Cleanup()

	p.mu.Lock()
	voice := p.voice
	p.mu.Unlock()
	if voice == nil {
		return fmt.Errorf("voice connection tidak tersedia")
	}

	done := make(chan error, 1)
	streamer := dca.NewStream(enc, voice, done)

	p.mu.Lock()
	p.encoder = enc
	p.streamer = streamer
	p.mu.Unlock()

	for {
		select {
		case err := <-done:
			p.mu.Lock()
			p.encoder = nil
			p.streamer = nil
			p.mu.Unlock()
			p.finishTrack(track, false)
			return err
		default:
		}

		p.mu.Lock()
		paused := p.paused
		currentPlayID := p.playID
		p.mu.Unlock()

		if currentPlayID != playID {
			p.mu.Lock()
			p.encoder = nil
			p.streamer = nil
			p.mu.Unlock()
			p.finishTrack(track, true)
			return nil
		}

		if paused {
			time.Sleep(250 * time.Millisecond)
			continue
		}

		time.Sleep(100 * time.Millisecond)
	}
}

func (p *GuildPlayer) finishTrack(track *media.TrackInfo, interrupted bool) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if track == nil {
		return
	}

	if !interrupted {
		if p.loopMode == LoopTrack {
			clone := *track
			clone.Offset = 0
			p.queue = append([]*media.TrackInfo{&clone}, p.queue...)
		} else if p.loopMode == LoopQueue {
			clone := *track
			clone.Offset = 0
			p.queue = append(p.queue, &clone)
		}

		track.Offset = 0
		p.history = append(p.history, track)
		if len(p.history) > 20 {
			p.history = p.history[len(p.history)-20:]
		}
	}
}

func (p *GuildPlayer) encode(track *media.TrackInfo) (*dca.EncodeSession, error) {
	input := track.StreamURL
	if input == "" {
		input = track.URL
	}

	opts := dca.StdEncodeOptions
	cloned := *opts
	cloned.RawOutput = true
	cloned.Bitrate = 128
	cloned.Application = dca.AudioApplicationAudio
	cloned.Volume = p.cfg.DefaultVolume

	if track.Offset > 0 {
		cloned.StartTime = int(track.Offset.Seconds())
	}

	return dca.EncodeFile(input, &cloned)
}

func (p *GuildPlayer) ensureVoiceLocked(voiceChannelID string) error {
	if p.voice != nil && p.channelID == voiceChannelID {
		return nil
	}
	if p.voice != nil {
		_ = p.voice.Disconnect()
		p.voice = nil
	}

	vc, err := p.session.ChannelVoiceJoin(p.guildID, voiceChannelID, false, true)
	if err != nil {
		return err
	}

	p.voice = vc
	p.channelID = voiceChannelID
	return nil
}

func (p *GuildPlayer) bumpIdleTimerLocked() {
	if p.idleTimer != nil {
		p.idleTimer.Stop()
	}

	p.idleTimer = time.AfterFunc(p.cfg.DefaultIdleTimeout, func() {
		_ = p.Stop()
	})
}

func (p *GuildPlayer) shouldSleep() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.sleepUntil != nil && time.Now().After(*p.sleepUntil)
}
