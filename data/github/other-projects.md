# Other Projects

## KoinX Assignment — Cryptocurrency Statistics Tracker

A microservices-based cryptocurrency statistics system. An API server fetches and serves Bitcoin, Ethereum, and Matic Network stats from CoinGecko. A separate worker server publishes scheduled update events via NATS message broker.

**Tech Stack:** Node.js, Express.js, MongoDB/Mongoose, NATS (message queue), Axios, node-cron
**Architecture:** Two separate services communicating via NATS pub/sub:
- **API Server:** REST API with versioned endpoints (v1 for reads, v2 for manual triggers). Controllers, services, routes, utils pattern.
- **Worker Server:** Background job runner that publishes `crypto.update` events on a cron schedule via NATS

**Key Design Decisions:**
- Microservices with NATS for decoupled communication — worker and API server are independently deployable
- Event-driven: worker publishes to NATS, API server subscribes and auto-updates stats
- Versioned API endpoints for backward compatibility
- Standard deviation calculation on price history for volatility tracking

**Honest Limitations:** Small scope (22 files total). Best viewed as a system design exercise demonstrating microservices and event-driven patterns rather than a standalone product.

---

## PixelHub (PixelVerse)

A pixel art gaming metaverse frontend built with Next.js 14, React 18, Tailwind CSS, and Framer Motion. Sections for games, marketplace, profiles, quests, community, and gallery. Frontend-only — no backend or data persistence. Built as a hackathon/design exercise.

---

## Face (Firebase Auth RBAC)

Firebase Authentication with role-based access control demo. React + FastAPI, Google OAuth, hardcoded role detection by email domain for Scaler School of Technology. A learning exercise, not a production system.
