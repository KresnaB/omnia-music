package player

import (
	"sync"

	"github.com/bwmarrin/discordgo"

	"omnia-music/internal/config"
	"omnia-music/internal/media"
)

type Manager struct {
	mu       sync.Mutex
	cfg      *config.Config
	session  *discordgo.Session
	resolver *media.Resolver
	lyrics   *media.LyricsClient
	players  map[string]*GuildPlayer
}

func NewManager(cfg *config.Config, s *discordgo.Session, resolver *media.Resolver, lyrics *media.LyricsClient) *Manager {
	return &Manager{
		cfg:      cfg,
		session:  s,
		resolver: resolver,
		lyrics:   lyrics,
		players:  make(map[string]*GuildPlayer),
	}
}

func (m *Manager) Get(guildID string) *GuildPlayer {
	m.mu.Lock()
	defer m.mu.Unlock()

	if p, ok := m.players[guildID]; ok {
		return p
	}

	p := NewGuildPlayer(m.cfg, m.session, m.resolver, m.lyrics, guildID)
	m.players[guildID] = p
	return p
}
