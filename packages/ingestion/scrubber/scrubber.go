// Package scrubber redacts stored session chunks before they become readable.
package scrubber

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/opslane/opslane/packages/ingestion/compress"
	"github.com/opslane/opslane/packages/ingestion/db"
	"github.com/opslane/opslane/packages/ingestion/masking"
	minioPkg "github.com/opslane/opslane/packages/ingestion/minio"
)

const (
	batchSize         = 20
	defaultInterval   = 15 * time.Second
	defaultMaxInflate = 20 << 20
	scrubTimeout      = 30 * time.Second
)

// Scrubber processes committed, unscrubbed chunks in bounded batches.
type Scrubber struct {
	Q               *db.Queries
	MinIO           *minioPkg.Client
	MaxInflateBytes int64
}

// resolveInterval picks the tick interval for Start. Only a non-positive
// interval is overridden. The retained 30s eligibility grace in
// ClaimUnscrubbedChunks is a separate privacy-timing decision: chunk uploads
// are no longer presigned (#194), so the grace is no longer load-bearing
// against replayed writes and must not be coupled to the tick rate.
func resolveInterval(interval time.Duration) time.Duration {
	if interval <= 0 {
		return defaultInterval
	}
	return interval
}

// Start runs scrub passes until ctx is cancelled.
func (s *Scrubber) Start(ctx context.Context, interval time.Duration) {
	interval = resolveInterval(interval)
	if s.MaxInflateBytes <= 0 {
		s.MaxInflateBytes = defaultMaxInflate
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			scrubbed, failed, err := s.RunOnce(ctx)
			if err != nil {
				slog.Error("chunk scrub pass failed", "error", err)
			} else if scrubbed > 0 || failed > 0 {
				slog.Info("chunk scrub pass", "scrubbed", scrubbed, "failed", failed)
			}
		}
	}
}

// RunOnce claims and processes one batch. A failed chunk remains unreadable.
func (s *Scrubber) RunOnce(ctx context.Context) (scrubbed, failed int, err error) {
	if s.Q == nil || s.MinIO == nil {
		return 0, 0, errors.New("scrubber dependencies are not configured")
	}
	if s.MaxInflateBytes <= 0 {
		s.MaxInflateBytes = defaultMaxInflate
	}

	chunks, err := s.Q.ClaimUnscrubbedChunks(ctx, batchSize)
	if err != nil {
		return 0, 0, err
	}
	for _, chunk := range chunks {
		chunkCtx, cancel := context.WithTimeout(ctx, scrubTimeout)
		scrubErr := s.scrubOne(chunkCtx, chunk)
		cancel()
		if scrubErr != nil {
			failed++
			slog.Warn("chunk scrub failed", "session_id", chunk.SessionID, "seq", chunk.Seq, "error", scrubErr)
			if markErr := s.Q.MarkChunkScrubFailed(ctx, chunk.SessionID, chunk.ProjectID, chunk.Seq, scrubErr.Error()); markErr != nil {
				slog.Error("recording scrub failure failed", "error", markErr)
			}
			continue
		}
		scrubbed++
	}
	return scrubbed, failed, nil
}

func (s *Scrubber) scrubOne(ctx context.Context, chunk db.ChunkRef) error {
	size, err := s.MinIO.StatObject(ctx, chunk.ObjectKey)
	if err != nil {
		return fmt.Errorf("stat chunk: %w", err)
	}
	if size > s.MaxInflateBytes {
		_ = s.MinIO.RemoveObject(ctx, chunk.ObjectKey)
		return errors.New("compressed chunk exceeds inflate ceiling")
	}

	raw, err := s.MinIO.GetObject(ctx, chunk.ObjectKey)
	if err != nil {
		return fmt.Errorf("read chunk: %w", err)
	}
	plain, err := compress.InflateLimited(bytes.NewReader(raw), s.MaxInflateBytes)
	if err != nil {
		if errors.Is(err, compress.ErrTooLarge) {
			_ = s.MinIO.RemoveObject(ctx, chunk.ObjectKey)
		}
		return err
	}
	if !json.Valid(plain) {
		_ = s.MinIO.RemoveObject(ctx, chunk.ObjectKey)
		return errors.New("chunk is not valid JSON")
	}
	firstEventMs, lastEventMs := chunkEventBounds(plain)

	regz, err := compress.Deflate(masking.RedactRecording(plain))
	if err != nil {
		return err
	}
	if err := s.MinIO.PutObject(ctx, chunk.ObjectKey, regz, "application/gzip"); err != nil {
		return fmt.Errorf("store scrubbed chunk: %w", err)
	}
	return s.Q.MarkChunkScrubbed(ctx, chunk.SessionID, chunk.ProjectID, chunk.Seq,
		firstEventMs, lastEventMs, int64(len(plain)))
}

// chunkEventBounds returns the minimum and maximum numeric rrweb timestamps in
// a chunk envelope. Entries are decoded independently so one malformed event
// cannot discard valid timestamps from the rest of the chunk.
func chunkEventBounds(plain []byte) (first, last *int64) {
	var envelope struct {
		Events []json.RawMessage `json:"events"`
	}
	if err := json.Unmarshal(plain, &envelope); err != nil {
		return nil, nil
	}
	for _, raw := range envelope.Events {
		var event struct {
			Timestamp *int64 `json:"timestamp"`
		}
		if err := json.Unmarshal(raw, &event); err != nil || event.Timestamp == nil {
			continue
		}
		timestamp := *event.Timestamp
		if first == nil || timestamp < *first {
			value := timestamp
			first = &value
		}
		if last == nil || timestamp > *last {
			value := timestamp
			last = &value
		}
	}
	return first, last
}
