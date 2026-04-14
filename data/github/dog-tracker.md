# Dog Tracker -- Lost Dog QR Code Recovery Platform

## Quick Summary
Dog Tracker is a Next.js full-stack application for pet owners to register dogs, generate QR-code dog tags, and recover lost pets. Owners create profiles with granular privacy controls (toggle visibility of name, phone, email, WhatsApp independently), upload photos, and activate "lost mode" with reward info. When someone finds a lost dog, they scan the QR code on the collar, see the dog's public profile, and submit a found report. The system includes JWT authentication, Zod validation, Prisma ORM with PostgreSQL, soft-delete patterns, and a full audit log that snapshots every change to a dog profile.

**Repo:** `abhinavjha0239/dog-tracker`
**Language:** TypeScript (Next.js full-stack)
**Key Dependencies:** Next.js, Prisma, jose (JWT), bcryptjs, qrcode, Zod, Cloudinary (planned)

## Architecture (actual file paths)

```
prisma/
  schema.prisma                     -- 6 models: User, OwnerProfile, Dog, DogPhoto, FoundReport, DogAuditLog
  migrations/                       -- Prisma migration history
src/
  lib/
    auth.ts                         -- JWT creation/verification, session management (jose + bcryptjs)
    db.ts                           -- Prisma client singleton (cached globally)
    qr.ts                           -- QR code generation (data URL + buffer output)
    validations.ts                  -- Zod schemas for all inputs (register, login, dog, lostMode, foundReport)
  app/
    api/
      auth/
        register/route.ts           -- POST: user registration with password hashing
        login/route.ts              -- POST: user login with password verification
        logout/route.ts             -- POST: clear session cookie
        me/route.ts                 -- GET: current user info
      dogs/
        route.ts                    -- GET: list user's dogs; POST: create dog
        [id]/
          route.ts                  -- GET/PUT/DELETE: single dog CRUD + lost mode toggle
          photos/route.ts           -- GET/POST: photo management (Cloudinary planned)
          photos/[photoId]/         -- DELETE: remove individual photo
          qr/route.ts               -- GET: generate QR code PNG for dog's public slug
          publish/                   -- POST: publish dog profile to public
          unpublish/                 -- POST: unpublish dog profile
          reports/                   -- GET: found reports for a dog
      found/
        [slug]/route.ts             -- POST: submit found-dog report (public, rate-limited)
      me/                           -- GET/PUT: owner profile management
    d/[slug]/                       -- Public dog profile page (no auth required)
    dashboard/                      -- Owner dashboard
    dogs/                           -- Dog management pages
    settings/                       -- Account settings
    login/                          -- Login page
    register/                       -- Registration page
```

## Technical Details

### 1. Prisma Schema (`prisma/schema.prisma`)

Six models with cascading deletes and privacy-first design:

```prisma
model User {
  id           String        @id @default(cuid())
  username     String        @unique
  passwordHash String
  ownerProfile OwnerProfile?
  dogs         Dog[]
  auditLogs    DogAuditLog[]
}

model OwnerProfile {
  userId       String   @unique
  user         User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  name         String?
  phone        String?
  showName     Boolean  @default(false)
  showPhone    Boolean  @default(false)
  showEmail    Boolean  @default(false)
  showWhatsapp Boolean  @default(false)
}
```

The `Dog` model includes emergency medical fields (`emergencyAllergies`, `emergencyMeds`, `emergencyConditions`, `vetContact`), lost mode fields (`lostMode`, `lostLastSeenText`, `lostLastSeenDate`, `reward`, `lostNotes`), and a soft-delete pattern (`isDeleted`, `deletedAt`). Each dog gets a unique `publicSlug` (CUID) for QR code URLs.

The `DogAuditLog` captures `changeSummary` (human-readable) and `snapshotJson` (full JSON dump of dog state at time of change).

### 2. JWT Authentication (`src/lib/auth.ts`)

Custom JWT implementation using `jose` library (not NextAuth):

```typescript
export async function createToken(payload: SessionPayload): Promise<string> {
    return new SignJWT(payload as unknown as Record<string, unknown>)
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime('7d')
        .sign(JWT_SECRET)
}

export async function getSession(): Promise<SessionPayload | null> {
    const cookieStore = await cookies()
    const token = cookieStore.get('auth-token')?.value
    if (!token) return null
    return verifyToken(token)
}
```

Session payload contains `userId` and `username`. Tokens expire in 7 days. Cookies are set with `httpOnly: true`, `secure` in production, and `sameSite: 'lax'`. Password hashing uses bcryptjs with 12 salt rounds.

### 3. Registration Flow (`src/app/api/auth/register/route.ts`)

Registration creates the user and an empty `OwnerProfile` in a single Prisma call, then sets the session cookie:

```typescript
const user = await prisma.user.create({
    data: {
        username,
        passwordHash,
        ownerProfile: {
            create: {}, // Create empty owner profile
        },
    },
})
await setSession({ userId: user.id, username: user.username })
```

### 4. QR Code Generation (`src/lib/qr.ts`, `src/app/api/dogs/[id]/qr/route.ts`)

QR codes encode the public URL `{BASE_URL}/d/{slug}`. The `getBaseUrl()` function checks `NEXT_PUBLIC_BASE_URL`, then Vercel env vars, then falls back to localhost:

```typescript
export async function generateQRCodeBuffer(slug: string): Promise<Buffer> {
    const url = `${getBaseUrl()}/d/${slug}`
    return QRCode.toBuffer(url, {
        width: 300, margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
    })
}
```

The API route fetches the dog by ID, generates a PNG buffer, and returns it with `Content-Disposition: attachment` for direct download.

### 5. Dog CRUD with Audit Logging (`src/app/api/dogs/[id]/route.ts`)

Every mutation (create, update, delete, lost mode toggle) creates an audit log entry:

```typescript
const dog = await prisma.dog.update({
    where: { id },
    data: result.data,
    include: { photos: true },
})

await prisma.dogAuditLog.create({
    data: {
        dogId: dog.id,
        userId: session.userId,
        changeSummary: 'Dog profile updated',
        snapshotJson: JSON.stringify(dog),
    },
})
```

The PUT handler detects whether the request is a lost mode update (checks `'lostMode' in body`) or a regular profile update, and validates against the appropriate Zod schema (`lostModeSchema` vs `dogSchema`).

**Soft delete:** The DELETE handler sets `isDeleted: true` and `deletedAt: new Date()`, and automatically unpublishes the dog (`isPublished: false`).

### 6. Found Report Submission (`src/app/api/found/[slug]/route.ts`)

Public endpoint (no auth required) with in-memory rate limiting:

```typescript
const RATE_LIMIT = 3           // max submissions
const RATE_LIMIT_WINDOW = 10 * 60 * 1000  // 10 minutes

function isRateLimited(ip: string): boolean {
    const record = rateLimitMap.get(ip)
    if (!record || now > record.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW })
        return false
    }
    return record.count >= RATE_LIMIT
}
```

The endpoint looks up the dog by `publicSlug` (must be published and not deleted), validates input with `foundReportSchema`, stores the finder's IP address for abuse tracking, and creates the `FoundReport` record. Rate limited to 3 submissions per IP per 10 minutes.

### 7. Zod Validation Schemas (`src/lib/validations.ts`)

All inputs are validated with Zod before touching the database:

```typescript
export const registerSchema = z.object({
    username: z.string().min(3).max(30)
        .regex(/^[a-zA-Z0-9_]+$/, 'letters, numbers, and underscores'),
    password: z.string().min(8)
        .regex(/[A-Z]/, 'at least one uppercase letter')
        .regex(/[0-9]/, 'at least one number'),
})

export const foundReportSchema = z.object({
    finderName: z.string().min(1).max(100),
    finderPhone: z.string().min(1).max(20),
    message: z.string().min(1).max(1000),
    foundLocationText: z.string().min(1).max(500),
})
```

Six schemas total: `registerSchema`, `loginSchema`, `ownerProfileSchema`, `dogSchema`, `lostModeSchema`, `foundReportSchema`. All exported as TypeScript inferred types (`z.infer<typeof ...>`).

### 8. Prisma Client Singleton (`src/lib/db.ts`)

```typescript
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}
export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
})
globalForPrisma.prisma = prisma
```

Cached globally in both dev and production to avoid connection pool exhaustion during hot reloads.

## Frequently Asked Questions

**Q: How does the QR code flow work end-to-end?**
A: Owner registers a dog (gets a unique `publicSlug` CUID) -> publishes the dog -> downloads QR code from `GET /api/dogs/[id]/qr` (PNG image encoding `{BASE_URL}/d/{slug}`) -> prints and attaches to collar. Finder scans QR -> lands on `/d/{slug}` public page -> sees dog info + owner contact (respecting privacy toggles) -> submits found report via `POST /api/found/{slug}`. The owner sees the report on their dashboard.

**Q: How does the privacy system work?**
A: The `OwnerProfile` has four boolean toggles: `showName`, `showPhone`, `showEmail`, `showWhatsapp`. All default to `false`. The public dog page (`/d/[slug]`) only renders contact fields where the corresponding toggle is `true`. The API response for public profiles filters these fields server-side before sending to the client.

**Q: How is authentication implemented?**
A: Custom JWT using the `jose` library. `createToken()` signs a payload with HS256, 7-day expiry. The token is stored in an httpOnly cookie named `auth-token` (secure in production, sameSite lax). `getSession()` reads the cookie and verifies the JWT. Every protected API route calls `getSession()` first and returns 401 if null. Passwords are hashed with bcryptjs (12 salt rounds).

**Q: Why soft delete instead of hard delete for dogs?**
A: Prevents accidental data loss. When a dog is "deleted," it sets `isDeleted: true` and `deletedAt: new Date()`, and auto-unpublishes (`isPublished: false`). All queries filter by `isDeleted: false`. The audit log still has the full history. A future "restore" feature could simply flip the flag back.

**Q: How does the audit log work?**
A: Every create, update, delete, and lost-mode-toggle on a dog creates a `DogAuditLog` entry with `changeSummary` (human-readable string like "Lost mode enabled") and `snapshotJson` (full JSON dump of the dog's state after the change). Linked to both `dogId` and `userId` for accountability.

**Q: How is the found report endpoint protected against abuse?**
A: In-memory rate limiting: max 3 submissions per IP address per 10-minute window. The IP is extracted from `x-forwarded-for` or `x-real-ip` headers. The IP is stored in the `FoundReport` record for abuse tracking but is not exposed to the finder. Zod validation prevents malformed input.

**Q: How are photos handled?**
A: The `DogPhoto` model stores Cloudinary URLs with a `isCover` boolean flag. Photos are ordered by cover status (cover first) then creation date. The upload endpoint is currently disabled (returns 503) pending Cloudinary integration for Vercel deployment -- local file storage doesn't work in serverless environments.

**Q: What's the database setup?**
A: PostgreSQL via Prisma ORM. The Prisma client is a global singleton to prevent connection pool exhaustion during Next.js hot reloads. Binary targets include `native` and `rhel-openssl-3.0.x` (for Linux production deployment). Relations use `onDelete: Cascade` so deleting a user removes all their dogs, photos, audit logs, etc.

## Design Tradeoffs

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| Custom JWT (jose) | jose + bcryptjs + httpOnly cookies | NextAuth | Full control over session flow; NextAuth adds OAuth complexity not needed for username/password auth. jose is lightweight and does not depend on Node.js crypto APIs (works in Edge Runtime) |
| CUID slugs | `@default(cuid())` for publicSlug | UUID v4 | CUIDs are shorter (25 chars vs 36), URL-friendly, monotonically sortable, and collision-resistant. Better for QR codes where URL length matters |
| Soft delete pattern | `isDeleted` + `deletedAt` flags | Hard DELETE | Prevents accidental data loss; enables future "restore" feature; audit trail remains intact |
| In-memory rate limiting | `Map<string, {count, resetAt}>` | Redis rate limiter | Simpler for single-instance deployment; acceptable for this traffic level. Would need Redis for multi-instance |
| Prisma ORM | Prisma + PostgreSQL | Drizzle, raw SQL | Strong TypeScript types, automatic migrations, good developer experience for CRUD-heavy app |
| Zod for validation | 6 Zod schemas with type inference | Manual validation | Type-safe, composable, gives meaningful error messages. Exported inferred types eliminate duplication |
| Audit log JSON snapshots | `snapshotJson: String` | Separate audit fields | Full snapshot captures everything including fields that might be added later. Using String instead of JSON type for SQLite compatibility (was originally SQLite) |

## What Makes This Impressive

1. **Privacy-first architecture** -- Granular per-field privacy toggles (4 booleans on `OwnerProfile`) with server-side filtering. Not just "public/private" profiles but fine-grained control over exactly which contact methods to expose to strangers.

2. **Complete found-dog recovery flow** -- QR code generation -> public profile -> found report submission with rate limiting + IP tracking. Designed for the stress scenario of someone finding a lost dog (simple form, no auth required, works from any phone's camera).

3. **Audit trail from day one** -- Every mutation creates a `DogAuditLog` with human-readable summary + full JSON snapshot. Enables change history, accountability, and potential "undo" functionality.

4. **Defense in depth for public endpoints** -- The found report endpoint combines Zod validation, rate limiting (3/IP/10min), IP tracking, and requires the dog to be both published and not deleted. No auth required but abuse is mitigated at multiple layers.

5. **Clean separation of concerns** -- Auth (jose), validation (Zod), database (Prisma), QR generation, and API routes are all in separate modules with clear interfaces. The validation schemas are exported as TypeScript types, eliminating type duplication.

6. **Soft delete with cascading state changes** -- Deleting a dog not only sets `isDeleted` but also unpublishes it, preventing the QR code from leading to a deleted dog's page. The audit log captures the deletion event.
