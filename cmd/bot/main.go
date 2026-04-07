package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/KresnaB/omnia-music/internal/app"
	"github.com/KresnaB/omnia-music/internal/config"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("load config: %v", err)
	}

	bot, err := app.New(cfg)
	if err != nil {
		log.Fatalf("create bot: %v", err)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := bot.Start(ctx); err != nil {
		log.Fatalf("start bot: %v", err)
	}

	<-ctx.Done()
	if err := bot.Close(context.Background()); err != nil {
		log.Printf("close bot: %v", err)
	}
}
