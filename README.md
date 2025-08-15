# Aurion v1 server

Endpoints:
- GET `/` -> health
- POST `/chat-sync` -> { message } -> { message, conv_id }
- POST `/chat` (SSE stream)

Auth: add header `Authorization: Bearer <AURION_API_SECRET>`
