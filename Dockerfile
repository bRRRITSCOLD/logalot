# Multi-stage build for the Go services (ingest-service, processor, query-service).
#
# One parameterized Dockerfile, not three near-identical copies (DRY): the target
# service is selected with `--build-arg SERVICE=<name>`. docker-compose.slice.yml
# passes it per service. The build context is the REPO ROOT so the Go workspace
# (go.work) and the shared pkg/* modules are available — each service module
# imports pkg/kernel, pkg/auth, pkg/broker, … which only resolve via the workspace.
#
#   docker build --build-arg SERVICE=ingest-service -t logalot/ingest-service .
#
# Final image is alpine (≈10 MB + the static binary) running as a non-root user.
# Alpine (over distroless) is deliberate: it ships wget so the compose HEALTHCHECK
# can probe /healthz without baking a probe binary into the image.

ARG GO_VERSION=1.26

# ---- build stage -----------------------------------------------------------
FROM golang:${GO_VERSION} AS build
ARG SERVICE
WORKDIR /src

# Copy the whole workspace. .dockerignore keeps the context lean (no node_modules,
# .git, etc.). go.work makes `go build` resolve the local pkg/* replacements.
COPY . .

# CGO off → a static binary that runs on the bare alpine final image. -trimpath +
# -ldflags strip paths and debug info for a smaller, reproducible artifact.
RUN test -n "$SERVICE" || (echo "build arg SERVICE is required" && exit 1) \
 && CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
      -o /out/service ./services/${SERVICE}/cmd/${SERVICE}

# ---- final stage -----------------------------------------------------------
FROM alpine:3.22
RUN apk add --no-cache ca-certificates wget \
 && addgroup -S logalot && adduser -S -G logalot logalot
COPY --from=build /out/service /usr/local/bin/service
USER logalot:logalot
ENTRYPOINT ["/usr/local/bin/service"]
