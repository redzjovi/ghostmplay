package marketplace

import (
	"context"
	"sync"
)

// pool runs fn over items with at most limit in flight and returns the results
// keyed by key(item).
//
// Results are keyed rather than returned positionally because the callers need
// to look up by an identifier -- an upstream item id, or a position in a list --
// and because Go structs are not usable map keys the way JavaScript objects are.
// Keying by index would work but pushes the "which index" bookkeeping onto every
// caller.
//
// The zero value of R is stored for a failed call, so a caller gets a usable
// map either way and a nil detail simply means the fetch did not succeed. The
// only two callers fetch details, and Detail already swallows its own failures
// by design; swallowing a second time here would hide a genuine cancellation,
// so a context error still propagates.
func pool[T any, R any, K comparable](
	ctx context.Context,
	limit int,
	items []T,
	key func(T) K,
	fn func(T) (R, error),
) (map[K]R, error) {
	results := make(map[K]R, len(items))
	if len(items) == 0 {
		return results, nil
	}

	workers := limit
	if workers > len(items) {
		workers = len(items)
	}
	if workers < 1 {
		workers = 1
	}

	var (
		mu     sync.Mutex
		cursor int
		wg     sync.WaitGroup
		errMu  sync.Mutex
		first  error
	)

	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				mu.Lock()
				idx := cursor
				cursor++
				mu.Unlock()

				if idx >= len(items) {
					return
				}

				item := items[idx]

				r, err := fn(item)
				if ctx.Err() != nil {
					errMu.Lock()
					if first == nil {
						first = ctx.Err()
					}
					errMu.Unlock()
					return
				}

				// A per-item failure is recorded as the zero value rather than
				// aborting: the marketplace scrape deliberately stores the
				// listing anyway, because a listing with no detail blob is a
				// normal state and refusing to record it would leave a gap in
				// the browse list.
				if err != nil {
					continue
				}

				mu.Lock()
				results[key(item)] = r
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if first != nil {
		return nil, first
	}
	return results, nil
}
