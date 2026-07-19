# syntax=docker/dockerfile:1.7

ARG GO_IMAGE=docker.io/library/golang:1.25-alpine
FROM ${GO_IMAGE} AS build

RUN apk add --no-cache ca-certificates
WORKDIR /src
COPY go.mod ./
COPY main.go main_test.go ./
RUN CGO_ENABLED=0 go test ./... \
  && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/safe-fetch-proxy .

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /out/safe-fetch-proxy /safe-fetch-proxy
USER 65532:65532
EXPOSE 8080
ENTRYPOINT ["/safe-fetch-proxy"]
