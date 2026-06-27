package platform

import (
	"context"
	"fmt"
	"net"
	"os"

	"github.com/redis/go-redis/v9"
)

// Redis environment variables, matching .env.example. Host/port build the
// address; password is optional (empty disables AUTH).
const (
	RedisHostEnv     = "REDIS_HOST"
	RedisPortEnv     = "REDIS_PORT"
	RedisPasswordEnv = "REDIS_PASSWORD"
)

// RedisConfig is the minimal connection config. Addr is "host:port".
type RedisConfig struct {
	Addr     string
	Password string
}

// RedisConfigFromEnv assembles a RedisConfig from REDIS_HOST/REDIS_PORT/
// REDIS_PASSWORD. Host and port are required; password may be empty.
func RedisConfigFromEnv() (RedisConfig, error) {
	host := os.Getenv(RedisHostEnv)
	port := os.Getenv(RedisPortEnv)
	if host == "" || port == "" {
		return RedisConfig{}, fmt.Errorf("platform: %s and %s must be set", RedisHostEnv, RedisPortEnv)
	}
	return RedisConfig{
		Addr:     net.JoinHostPort(host, port),
		Password: os.Getenv(RedisPasswordEnv),
	}, nil
}

// NewRedisClient builds a go-redis client for cfg and verifies connectivity with
// a PING. The caller owns the client and MUST Close it.
func NewRedisClient(ctx context.Context, cfg RedisConfig) (*redis.Client, error) {
	client := redis.NewClient(&redis.Options{
		Addr:     cfg.Addr,
		Password: cfg.Password,
	})
	if err := client.Ping(ctx).Err(); err != nil {
		_ = client.Close()
		return nil, fmt.Errorf("platform: ping redis: %w", err)
	}
	return client, nil
}
