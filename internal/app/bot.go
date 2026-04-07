package app

import (
	"context"
	"fmt"
	"log"
	"strings"
	"time"

	"github.com/bwmarrin/discordgo"

	"omnia-music/internal/config"
	"omnia-music/internal/media"
	"omnia-music/internal/player"
)

type Bot struct {
	cfg      *config.Config
	session  *discordgo.Session
	resolver *media.Resolver
	lyrics   *media.LyricsClient
	players  *player.Manager
	cmds     []*discordgo.ApplicationCommand
}

func New(cfg *config.Config) (*Bot, error) {
	s, err := discordgo.New("Bot " + cfg.DiscordToken)
	if err != nil {
		return nil, err
	}

	s.Identify.Intents = discordgo.IntentsGuilds | discordgo.IntentsGuildVoiceStates

	resolver := media.NewResolver(cfg)
	lyrics := media.NewLyricsClient(cfg)

	b := &Bot{
		cfg:      cfg,
		session:  s,
		resolver: resolver,
		lyrics:   lyrics,
		players:  player.NewManager(cfg, s, resolver, lyrics),
		cmds:     commands(),
	}

	s.AddHandler(b.onInteractionCreate)
	return b, nil
}

func (b *Bot) Start(ctx context.Context) error {
	if err := b.session.Open(); err != nil {
		return err
	}
	if err := b.registerCommands(); err != nil {
		return err
	}
	log.Println("Omnia Music is online")
	return nil
}

func (b *Bot) Close(ctx context.Context) error {
	_ = b.unregisterCommands()
	return b.session.Close()
}

func (b *Bot) registerCommands() error {
	for _, cmd := range b.cmds {
		if _, err := b.session.ApplicationCommandCreate(b.session.State.User.ID, b.cfg.DevGuildID, cmd); err != nil {
			return fmt.Errorf("register %s: %w", cmd.Name, err)
		}
	}
	return nil
}

func (b *Bot) unregisterCommands() error {
	cmds, err := b.session.ApplicationCommands(b.session.State.User.ID, b.cfg.DevGuildID)
	if err != nil {
		return err
	}
	for _, cmd := range cmds {
		_ = b.session.ApplicationCommandDelete(b.session.State.User.ID, b.cfg.DevGuildID, cmd.ID)
	}
	return nil
}

func (b *Bot) onInteractionCreate(s *discordgo.Session, i *discordgo.InteractionCreate) {
	switch i.Type {
	case discordgo.InteractionApplicationCommand:
		b.handleCommand(s, i)
	case discordgo.InteractionMessageComponent:
		b.handleComponent(s, i)
	}
}

func (b *Bot) handleCommand(s *discordgo.Session, i *discordgo.InteractionCreate) {
	switch i.ApplicationCommandData().Name {
	case "play":
		b.handlePlay(s, i)
	case "skip":
		b.respondAction(s, i, "Lagu dilewati.", b.playerFor(i).Skip())
	case "stop":
		b.respondAction(s, i, "Playback dihentikan dan voice connection ditutup.", b.playerFor(i).Stop())
	case "seek":
		seconds := optionInt(i, "seconds")
		b.respondAction(s, i, fmt.Sprintf("Seek ke %d detik.", seconds), b.playerFor(i).Seek(time.Duration(seconds)*time.Second))
	case "queue":
		b.handleQueue(s, i)
	case "loop":
		mode := player.LoopMode(optionString(i, "mode"))
		b.playerFor(i).SetLoopMode(mode)
		b.respondAction(s, i, fmt.Sprintf("Loop mode diubah ke `%s`.", mode), nil)
	case "shuffle":
		count := b.playerFor(i).Shuffle()
		b.respondAction(s, i, fmt.Sprintf("Queue diacak. Total: %d.", count), nil)
	case "autoplay":
		enabled := b.playerFor(i).ToggleAutoplay()
		b.respondAction(s, i, fmt.Sprintf("Autoplay `%t`.", enabled), nil)
	case "help":
		b.respondEmbed(s, i, helpEmbed())
	case "move":
		from := optionInt(i, "from")
		to := optionInt(i, "to")
		b.respondAction(s, i, fmt.Sprintf("Queue dipindah dari %d ke %d.", from, to), b.playerFor(i).Move(from, to))
	case "status":
		b.handleStatus(s, i)
	case "lyrics":
		b.handleLyrics(s, i)
	case "sleep":
		minutes := optionInt(i, "minutes")
		when := b.playerFor(i).SetSleep(time.Duration(minutes) * time.Minute)
		b.respondAction(s, i, fmt.Sprintf("Sleep timer aktif sampai %s.", when.Format(time.RFC1123)), nil)
	case "reconnect":
		channelID, err := userVoiceChannelID(s, i.GuildID, i.Member.User.ID)
		if err != nil {
			b.respondAction(s, i, "", err)
			return
		}
		b.respondAction(s, i, "Voice connection disambungkan ulang.", b.playerFor(i).Reconnect(channelID))
	}
}

func (b *Bot) handlePlay(s *discordgo.Session, i *discordgo.InteractionCreate) {
	channelID, err := userVoiceChannelID(s, i.GuildID, i.Member.User.ID)
	if err != nil {
		b.respondAction(s, i, "", err)
		return
	}

	track, err := b.playerFor(i).Enqueue(context.Background(), channelID, optionString(i, "query"), i.Member.DisplayName(), i.Member.User.ID)
	if err != nil {
		b.respondAction(s, i, "", err)
		return
	}

	b.respondRich(s, i, nowPlayingEmbed(track, b.playerFor(i).Status()), controlRows())
}

func (b *Bot) handleQueue(s *discordgo.Session, i *discordgo.InteractionCreate) {
	queue, current := b.playerFor(i).QueueSnapshot()
	lines := make([]string, 0, len(queue)+1)

	if current != nil {
		lines = append(lines, "Sedang diputar: **"+current.Title+"**")
	}
	if len(queue) == 0 {
		lines = append(lines, "Queue kosong.")
	} else {
		for idx, item := range queue {
			if idx >= 10 {
				lines = append(lines, fmt.Sprintf("...dan %d lagu lain.", len(queue)-10))
				break
			}
			lines = append(lines, fmt.Sprintf("%d. %s", idx+1, item.Title))
		}
	}

	b.respondEmbed(s, i, &discordgo.MessageEmbed{
		Title:       "Queue",
		Description: strings.Join(lines, "\n"),
		Color:       0x00C2FF,
	})
}

func (b *Bot) handleStatus(s *discordgo.Session, i *discordgo.InteractionCreate) {
	st := b.playerFor(i).Status()
	lines := []string{
		fmt.Sprintf("Connected: `%t`", st.Connected),
		fmt.Sprintf("Paused: `%t`", st.Paused),
		fmt.Sprintf("Loop: `%s`", st.LoopMode),
		fmt.Sprintf("Autoplay: `%t`", st.Autoplay),
		fmt.Sprintf("Queue size: `%d`", st.QueueSize),
	}
	if st.Current != nil {
		lines = append(lines, "Current: **"+st.Current.Title+"**")
	}
	if st.SleepUntil != nil {
		lines = append(lines, "Sleep until: `"+st.SleepUntil.Format(time.RFC1123)+"`")
	}

	b.respondEmbed(s, i, &discordgo.MessageEmbed{
		Title:       "Player Status",
		Description: strings.Join(lines, "\n"),
		Color:       0x2ECC71,
	})
}

func (b *Bot) handleLyrics(s *discordgo.Session, i *discordgo.InteractionCreate) {
	result, err := b.playerFor(i).FetchLyrics(context.Background())
	if err != nil {
		b.respondAction(s, i, "", err)
		return
	}

	text := result.PlainLyrics
	if result.SyncedLyrics != "" {
		text = result.SyncedLyrics
	}
	if len(text) > 3500 {
		text = text[:3500] + "\n..."
	}

	b.respondEmbed(s, i, &discordgo.MessageEmbed{
		Title:       fmt.Sprintf("Lyrics: %s - %s", result.ArtistName, result.TrackName),
		Description: text,
		Color:       0xF1C40F,
	})
}

func (b *Bot) handleComponent(s *discordgo.Session, i *discordgo.InteractionCreate) {
	p := b.playerFor(i)
	action := i.MessageComponentData().CustomID

	var message string
	var err error

	switch action {
	case "player:toggle":
		var paused bool
		paused, err = p.TogglePause()
		if paused {
			message = "Playback dijeda."
		} else {
			message = "Playback dilanjutkan."
		}
	case "player:skip":
		err = p.Skip()
		message = "Lagu dilewati."
	case "player:stop":
		err = p.Stop()
		message = "Playback dihentikan."
	case "player:shuffle":
		message = fmt.Sprintf("Queue diacak. Total: %d.", p.Shuffle())
	case "player:autoplay":
		message = fmt.Sprintf("Autoplay `%t`.", p.ToggleAutoplay())
	case "player:loop":
		next := nextLoopMode(p.Status().LoopMode)
		p.SetLoopMode(next)
		message = fmt.Sprintf("Loop mode diubah ke `%s`.", next)
	case "player:queue":
		queue, current := p.QueueSnapshot()
		lines := []string{}
		if current != nil {
			lines = append(lines, "Now playing: "+current.Title)
		}
		for idx, item := range queue {
			if idx >= 10 {
				break
			}
			lines = append(lines, fmt.Sprintf("%d. %s", idx+1, item.Title))
		}
		if len(lines) == 0 {
			lines = append(lines, "Queue kosong.")
		}
		message = strings.Join(lines, "\n")
	case "player:lyrics":
		var result *media.LyricsResult
		result, err = p.FetchLyrics(context.Background())
		if err == nil {
			message = result.PlainLyrics
			if result.SyncedLyrics != "" {
				message = result.SyncedLyrics
			}
			if len(message) > 1500 {
				message = message[:1500] + "\n..."
			}
		}
	}

	if err != nil {
		message = "Error: " + err.Error()
	}

	_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: message,
			Flags:   discordgo.MessageFlagsEphemeral,
		},
	})
}

func (b *Bot) respondAction(s *discordgo.Session, i *discordgo.InteractionCreate, success string, err error) {
	if err != nil {
		success = "Error: " + err.Error()
	}
	_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Content: success,
			Flags:   discordgo.MessageFlagsEphemeral,
		},
	})
}

func (b *Bot) respondEmbed(s *discordgo.Session, i *discordgo.InteractionCreate, embed *discordgo.MessageEmbed) {
	_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Embeds: []*discordgo.MessageEmbed{embed},
			Flags:  discordgo.MessageFlagsEphemeral,
		},
	})
}

func (b *Bot) respondRich(s *discordgo.Session, i *discordgo.InteractionCreate, embed *discordgo.MessageEmbed, components []discordgo.MessageComponent) {
	_ = s.InteractionRespond(i.Interaction, &discordgo.InteractionResponse{
		Type: discordgo.InteractionResponseChannelMessageWithSource,
		Data: &discordgo.InteractionResponseData{
			Embeds:     []*discordgo.MessageEmbed{embed},
			Components: components,
		},
	})
}

func (b *Bot) playerFor(i *discordgo.InteractionCreate) *player.GuildPlayer {
	return b.players.Get(i.GuildID)
}

func commands() []*discordgo.ApplicationCommand {
	return []*discordgo.ApplicationCommand{
		{Name: "play", Description: "Putar lagu dari YouTube atau query", Options: []*discordgo.ApplicationCommandOption{{Type: discordgo.ApplicationCommandOptionString, Name: "query", Description: "Judul lagu atau URL", Required: true}}},
		{Name: "skip", Description: "Lewati lagu saat ini"},
		{Name: "stop", Description: "Hentikan playback"},
		{Name: "seek", Description: "Pindah posisi playback", Options: []*discordgo.ApplicationCommandOption{{Type: discordgo.ApplicationCommandOptionInteger, Name: "seconds", Description: "Posisi detik", Required: true}}},
		{Name: "queue", Description: "Lihat antrean lagu"},
		{Name: "loop", Description: "Atur loop mode", Options: []*discordgo.ApplicationCommandOption{{Type: discordgo.ApplicationCommandOptionString, Name: "mode", Description: "Mode loop", Required: true, Choices: []*discordgo.ApplicationCommandOptionChoice{{Name: "off", Value: "off"}, {Name: "track", Value: "track"}, {Name: "queue", Value: "queue"}}}}},
		{Name: "shuffle", Description: "Acak queue"},
		{Name: "autoplay", Description: "Toggle autoplay"},
		{Name: "help", Description: "Bantuan command"},
		{Name: "move", Description: "Pindahkan posisi queue", Options: []*discordgo.ApplicationCommandOption{{Type: discordgo.ApplicationCommandOptionInteger, Name: "from", Description: "Posisi awal", Required: true}, {Type: discordgo.ApplicationCommandOptionInteger, Name: "to", Description: "Posisi tujuan", Required: true}}},
		{Name: "status", Description: "Status player"},
		{Name: "lyrics", Description: "Ambil lyrics dari LRCLIB"},
		{Name: "sleep", Description: "Stop playback setelah beberapa menit", Options: []*discordgo.ApplicationCommandOption{{Type: discordgo.ApplicationCommandOptionInteger, Name: "minutes", Description: "Jumlah menit", Required: true}}},
		{Name: "reconnect", Description: "Sambung ulang voice connection"},
	}
}

func optionString(i *discordgo.InteractionCreate, name string) string {
	for _, opt := range i.ApplicationCommandData().Options {
		if opt.Name == name {
			return opt.StringValue()
		}
	}
	return ""
}

func optionInt(i *discordgo.InteractionCreate, name string) int {
	for _, opt := range i.ApplicationCommandData().Options {
		if opt.Name == name {
			return int(opt.IntValue())
		}
	}
	return 0
}

func userVoiceChannelID(s *discordgo.Session, guildID, userID string) (string, error) {
	guild, err := s.State.Guild(guildID)
	if err != nil {
		guild, err = s.Guild(guildID)
		if err != nil {
			return "", err
		}
	}
	for _, state := range guild.VoiceStates {
		if state.UserID == userID {
			return state.ChannelID, nil
		}
	}
	return "", fmt.Errorf("kamu harus berada di voice channel terlebih dahulu")
}

func nowPlayingEmbed(track *media.TrackInfo, st player.Status) *discordgo.MessageEmbed {
	desc := []string{
		fmt.Sprintf("Durasi: `%s`", formatDuration(track.Duration)),
		fmt.Sprintf("Requester: <@%s>", track.RequestedByID),
		fmt.Sprintf("Loop: `%s`", st.LoopMode),
		fmt.Sprintf("Autoplay: `%t`", st.Autoplay),
	}

	embed := &discordgo.MessageEmbed{
		Title:       "Now Playing",
		Description: strings.Join(desc, "\n"),
		URL:         track.URL,
		Color:       0x5865F2,
		Fields: []*discordgo.MessageEmbedField{
			{Name: "Judul", Value: track.Title},
			{Name: "Uploader", Value: fallback(track.Uploader, "Unknown"), Inline: true},
			{Name: "Sumber", Value: fallback(track.Source, "Unknown"), Inline: true},
		},
	}

	if track.Thumbnail != "" {
		embed.Thumbnail = &discordgo.MessageEmbedThumbnail{URL: track.Thumbnail}
	}
	return embed
}

func helpEmbed() *discordgo.MessageEmbed {
	return &discordgo.MessageEmbed{
		Title: "Omnia Music Help",
		Description: strings.Join([]string{
			"`/play <query>` putar lagu atau tambah ke queue",
			"`/skip` lewati lagu sekarang",
			"`/stop` stop dan disconnect",
			"`/seek <seconds>` lompat ke posisi tertentu",
			"`/queue` lihat queue aktif",
			"`/loop <off|track|queue>` atur loop mode",
			"`/shuffle` acak queue",
			"`/autoplay` toggle autoplay",
			"`/move <from> <to>` pindah antrean",
			"`/status` lihat status player",
			"`/lyrics` ambil lirik saat ini",
			"`/sleep <minutes>` auto stop",
			"`/reconnect` sambung ulang voice",
		}, "\n"),
		Color: 0x95A5A6,
	}
}

func controlRows() []discordgo.MessageComponent {
	return []discordgo.MessageComponent{
		discordgo.ActionsRow{
			Components: []discordgo.MessageComponent{
				discordgo.Button{Label: "Play/Pause", Style: discordgo.PrimaryButton, CustomID: "player:toggle"},
				discordgo.Button{Label: "Skip", Style: discordgo.SecondaryButton, CustomID: "player:skip"},
				discordgo.Button{Label: "Stop", Style: discordgo.DangerButton, CustomID: "player:stop"},
				discordgo.Button{Label: "Shuffle", Style: discordgo.SecondaryButton, CustomID: "player:shuffle"},
			},
		},
		discordgo.ActionsRow{
			Components: []discordgo.MessageComponent{
				discordgo.Button{Label: "Autoplay", Style: discordgo.SecondaryButton, CustomID: "player:autoplay"},
				discordgo.Button{Label: "Loop", Style: discordgo.SecondaryButton, CustomID: "player:loop"},
				discordgo.Button{Label: "Queue", Style: discordgo.SecondaryButton, CustomID: "player:queue"},
				discordgo.Button{Label: "Lyrics", Style: discordgo.SecondaryButton, CustomID: "player:lyrics"},
			},
		},
	}
}

func nextLoopMode(mode player.LoopMode) player.LoopMode {
	switch mode {
	case player.LoopOff:
		return player.LoopTrack
	case player.LoopTrack:
		return player.LoopQueue
	default:
		return player.LoopOff
	}
}

func formatDuration(d time.Duration) string {
	total := int(d.Seconds())
	h := total / 3600
	m := (total % 3600) / 60
	s := total % 60
	if h > 0 {
		return fmt.Sprintf("%02d:%02d:%02d", h, m, s)
	}
	return fmt.Sprintf("%02d:%02d", m, s)
}

func fallback(v, alt string) string {
	if strings.TrimSpace(v) == "" {
		return alt
	}
	return v
}
