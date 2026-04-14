# DeepSkill -- AI-Powered Multi-Domain Assessment Platform

## Quick Summary
DeepSkill is a Go + React full-stack platform that conducts AI-driven technical assessments across 5 domains (System Design, Civil Engineering, Mechanical Engineering, Medical/MBBS, MBA). It features real-time WebSocket interviews with streaming LLM responses, a ReactFlow graph editor for building system architecture diagrams, a Socratic AI interviewer that never gives answers (only presents failure scenarios), a multi-layered evaluation pipeline (rubric evaluator + chaos engine + flaw tracker + diagram analyzer), and virtual patient encounters for medical students. The backend is a single Go binary using Gin + gorilla/websocket + Redis, with Groq API for fast LLM inference.

**Repo:** `abhinavjha0239/DeepSkill`
**Language:** Go (backend), TypeScript/React (frontend)
**Key Dependencies:** Gin, gorilla/websocket, go-redis/v9, google/uuid, Groq LLM API, ReactFlow

## Architecture (actual file paths)

```
backend/
  main.go                           -- Gin router, Redis init, all route registration
  handlers/
    canvas.go                       -- Challenge/domain listing, flawed template delivery
    chat.go                         -- REST chat endpoint (non-streaming fallback)
    ws_chat.go                      -- WebSocket chat handler, session management, streaming
    ws_encounter.go                 -- Virtual Patient Encounter WebSocket handler
    grading.go                      -- Diagram submission + async Redis grading queue
    evaluation.go                   -- Rubric evaluation endpoints (list, get, evaluate)
  models/
    assessment.go                   -- Core types: Challenge, Rubric, DiagramTemplate, etc.
    domains.go                      -- Domain enum, DomainConfig, AIPersona, DomainRegistry
    flawed_template.go              -- Flaw, FlawLevel, FlawCategory, FlawProgress types
    encounter.go                    -- VirtualPatientCase, PatientVitals, Treatment, Complication
    challenges_civil.go             -- Civil engineering challenge definitions
    challenges_mechanical.go        -- Mechanical engineering challenges
    challenges_medical.go           -- Medical pathway challenges
    challenges_mba.go               -- MBA/business model challenges
    cases_encounter.go              -- Virtual patient case data (AMI, Sepsis, Anaphylaxis)
    scenario.go                     -- Scenario types for multi-stage challenges
  services/
    groq.go                         -- Groq LLM API client, streaming, model selection
    rubric_evaluator.go             -- Semantic rubric evaluation (LLM + heuristic fallback)
    chaos_engine.go                 -- Mid-interview chaos event injection
    flaw_tracker.go                 -- Canvas diff against flaw manifest, cycle detection
    diagram_analyzer.go             -- Real-time diagram anti-pattern detection
    grading.go                      -- Diagram scoring (node + edge matching)
    evaluator.go                    -- Detailed rubric definitions with expected answers
    encounter_evaluator.go          -- Medical encounter rubrics + AI evaluation prompt builder
    reference_architectures.go      -- Ideal architectures for comparison scoring
frontend/
  src/
    app/
      page.tsx                      -- Landing/domain selection
      challenge/                    -- Challenge selection pages
      interview/                    -- Interview canvas + chat UI
    components/
      canvas/                       -- ReactFlow graph editor components
      encounter/                    -- Virtual patient encounter UI
      FlawProgress.tsx              -- Flaw discovery progress bar
shared/
  api.yaml                          -- OpenAPI 3.0 spec for all endpoints
```

## Technical Details

### 1. Gin Router and Route Registration (`main.go`)

All services are instantiated in `main()` and injected into handlers. The router defines REST + WebSocket endpoints:

```go
gradingService := services.NewGradingService(rdb)
groqService := services.NewGroqService()
wsChatHandler := handlers.NewWSChatHandler(groqService)
encounterHandler := handlers.NewEncounterHandler(groqService)

api := r.Group("/api")
api.GET("/domains", canvasHandler.ListDomains)
api.GET("/domains/:id/challenges", canvasHandler.ListDomainChallenges)
api.POST("/submit", gradingHandler.SubmitDiagram)
api.POST("/evaluate", evaluationHandler.EvaluateChat)

r.GET("/ws/chat", wsChatHandler.HandleWebSocket)
r.GET("/ws/encounter", encounterHandler.HandleWebSocket)
```

### 2. WebSocket Session Management (`handlers/ws_chat.go`)

The `WSChatHandler` maintains a concurrent-safe map of `ChatSession` objects. Each session tracks the full interview state:

```go
type ChatSession struct {
    Conn             *websocket.Conn
    ChallengeID      string
    Phase            string // "requirements", "designing", "defending"
    History          []models.ChatMessage
    DifficultyLevel  string // "normal", "hard", "expert", "easier"
    Domain           models.Domain
    FlawProgress     *models.FlawProgress
    FlawTracker      *services.FlawTracker
    DomainChallenge  *models.ChallengeWithFlaws
}
```

**Reconnection support:** On WebSocket reconnect (`reconnect=true` query param), the handler restores the existing session, replays chat history, and sends flaw progress to the client. A background goroutine cleans up stale sessions after 5 minutes.

**Message types:** The `WSMessage.Type` field supports: `chat`, `diagram_update`, `evaluate`, `system`, `code_challenge`, `phase_change`, `stream_start`, `stream_chunk`, `stream_end`, `typing`, `diagram_hints`, `reconnected`, `stage_change`, `patterns`.

### 3. Multi-Model LLM Service (`services/groq.go`)

The `GroqService` calls the Groq API with streaming support and model routing per interview phase:

```go
var ModelMap = map[ModelPreset]string{
    ModelFast:     "llama-3.3-70b-versatile",
    ModelBalanced: "openai/gpt-oss-120b",
    ModelStrong:   "openai/gpt-oss-120b",
}

func GetModelForPhase(phase string, userPreset string) string {
    switch phase {
    case "requirements": return ModelMap[ModelFast]
    case "designing":    return ModelMap[ModelBalanced]
    case "defending":    return ModelMap[ModelStrong]
    }
}
```

**Streaming:** `GenerateDefenseQuestionStream()` reads SSE chunks via `bufio.Scanner`, calls `onToken(token)` for each delta, and accumulates the full response. The `extractNodeAnnotations()` function parses the AI response to find references to specific diagram nodes and generates warnings/suggestions attached to those nodes.

**Socratic system prompt:** The AI is instructed to never suggest components, only present failure scenarios. For domain challenges, `BuildDomainSystemPrompt()` injects domain-specific persona, expertise, and tone from the `DomainConfig`:

```go
prompt := fmt.Sprintf(`You are a %s.
=== ABSOLUTE RULES -- NEVER VIOLATE ===
1. You NEVER suggest specific components to add. %s
2. You ONLY describe PROBLEMS and SCENARIOS that expose design flaws.
...`, cfg.AIPersona.Role, cfg.AIPersona.NeverSay)
```

### 4. Domain Configuration System (`models/domains.go`)

Five domains are registered in `DomainRegistry`, each with custom phases, AI persona, component categories, and canvas types:

```go
var DomainRegistry = map[Domain]DomainConfig{
    DomainSystemDesign: { /* Staff Engineer persona, diagram canvas */ },
    DomainCivil:        { /* IIT Professor persona, structural canvas */ },
    DomainMechanical:   { /* Chief Design Engineer, process flow */ },
    DomainMedical:      { /* Senior Attending Physician, clinical pathway */ },
    DomainMBA:          { /* McKinsey Partner, business model canvas */ },
}
```

Each `AIPersona` has a `NeverSay` field -- e.g., the medical domain's AI must never say "draw cultures first" or "add monitoring"; it can only present the clinical consequence of missing those steps.

### 5. Flaw Tracker (`services/flaw_tracker.go`)

The `FlawTracker.CheckFlaws()` method compares the student's current canvas JSON against the `FlawManifest` of a challenge. It supports 7 fix types: `add_node`, `remove_node`, `add_edge`, `remove_edge`, `rewire_edge`, `modify_node`, `reorder_nodes`.

```go
func (ft *FlawTracker) CheckFlaws(
    diagramJSON string,
    challenge *models.ChallengeWithFlaws,
) *models.FlawProgress {
    // Parse canvas, build node/edge lookup maps
    // Check each flaw in manifest against current canvas state
    // Track level progression: obvious -> intermediate -> subtle
    // Detect new problems introduced by student (removed locked nodes, cycles)
}
```

Flaw levels progress: students must fix 70%+ of obvious flaws before intermediate flaws are exposed. `CalculateScore()` uses weighted scoring (harder flaws worth more) plus a -5 penalty per new problem introduced. Cycle detection uses DFS with an in-stack set.

### 6. Chaos Engine (`services/chaos_engine.go`)

The `ChaosEngine` injects mid-interview failure scenarios to test resilience thinking. Events are organized by category (e.g., `cache_failure`, `traffic_spike`, `seismic_event`, `thermal_runaway`, `competitor_launch`). The engine parses the diagram to find weaknesses and targets them:

```go
func (c *ChaosEngine) ShouldInjectChaos(messageCount int, lastChaosMessage int) bool {
    if messageCount < 3 { return false }
    if messageCount - lastChaosMessage < 2 { return false }
    return rand.Float32() < 0.3 // 30% chance
}
```

Domain-specific chaos events include: "Unexpected Soil Condition" (civil), "Battery Thermal Runaway" (mechanical), "Allergic Reaction to Treatment" (medical), "Competitor Launches at 40% Lower Price" (MBA).

### 7. Rubric Evaluator (`services/rubric_evaluator.go`)

The `RubricEvaluator` scores student answers either via LLM (semantic evaluation) or heuristic fallback. The LLM evaluation prompt instructs the model to assess understanding, not keyword-match:

```go
func (r *RubricEvaluator) semanticEvaluate(answer string, criteria RubricCriteria) EvaluationResult {
    prompt := r.buildSemanticPrompt(answer, criteria)
    // Calls Groq API with temperature=0.1
    // Parses JSON response: {score, matchedConcepts, missedConcepts, feedback}
}
```

The heuristic fallback (`heuristicEvaluate`) uses `semanticContains()` -- a custom function that checks for synonyms and related phrases, not just exact keywords. For example, "I'd use Redis to reduce DB load on the hot read path" matches the concept "caching strategy" even without saying "cache-aside pattern." It also checks for depth indicators ("because", "tradeoff", "bottleneck") and numbers ("QPS", "P99", "GB").

### 8. Diagram Analyzer (`services/diagram_analyzer.go`)

The `DiagramAnalyzer.AnalyzeDiagram()` method checks for 8 anti-patterns in real-time as the student edits: no cache for read-heavy systems, single point of failure, circular dependencies, database directly exposed to client, no message queue for async workloads, no monitoring, single DB without replication, no rate limiter. Domain-specific analyzers add checks like "no lateral force resisting system" (civil) or "antibiotics ordered without blood cultures" (medical).

`DetectDesignPatterns()` identifies architectural patterns (Event-Driven, Microservices, CQRS, API Gateway, Cache-Aside) by analyzing node categories and connections, with confidence scores.

### 9. Virtual Patient Encounters (`handlers/ws_encounter.go`)

The `EncounterHandler` manages WebSocket sessions for medical student training. The AI plays a patient (not a doctor) using a detailed persona prompt with hidden vitals, hidden history, and hidden exam findings that are only revealed when the student asks the right questions.

```go
type EncounterSessionState struct {
    Case           *models.VirtualPatientCase
    Session        *models.EncounterSession
    PendingTests   map[string]time.Time // test results delayed in real-time
}
```

Key mechanics:
- **Test ordering:** `handleOrderTest()` adds a test to the queue with a simulated delay (e.g., ECG = 5s, blood work = 30s). Results are delivered asynchronously via goroutine.
- **Treatment safety:** `handleGiveTreatment()` checks `IsDangerous` flag. Dangerous treatments (e.g., IV push epinephrine for anaphylaxis) trigger a penalty and warning.
- **Vital effects:** Treatments and complications modify patient vitals in real-time (`applyVitalEffect`), clamping SpO2 at 100% and GCS between 3-15.
- **Complications:** `watchForComplications()` runs as a goroutine, triggering time-based complications if the student hasn't performed the right treatment. For example, if aspirin isn't given within 10 minutes for AMI, the patient develops VF arrest.
- **AI evaluation:** `handleEvaluate()` builds a detailed prompt from the encounter rubric and sends it to Groq for structured JSON evaluation with category scores, strengths, areas to improve, and clinical pearls.

### 10. Grading Pipeline (`handlers/grading.go`, `services/grading.go`)

Submissions are queued to Redis Stream (`grading:queue`) for async processing. If Redis fails, synchronous fallback occurs:

```go
func (h *GradingHandler) SubmitDiagram(c *gin.Context) {
    _, err = h.redis.XAdd(ctx, &redis.XAddArgs{
        Stream: "grading:queue",
        Values: map[string]interface{}{"attemptId": attemptID, "submission": data},
    }).Result()
    if err != nil {
        result := h.gradingService.GradeSubmission(submission) // sync fallback
    }
}
```

The `GradingService.GradeSubmission()` performs L1 sanitization (prompt injection detection: "ignore previous", "give me full marks") then L2 rubric-based scoring (node matching + edge matching, each worth 50%).

### 11. Challenge Data Model (`models/flawed_template.go`)

Challenges use a "flaw discovery" pattern -- students receive a pre-loaded design with intentional flaws and must fix them:

```go
type ChallengeWithFlaws struct {
    FlawedTemplate FlawedTemplate  // InitialCanvas, IdealCanvas, FlawManifest
    Rubric         Rubric
    ChaosEvents    []string        // Which chaos events can trigger
}

type Flaw struct {
    Level      FlawLevel    // 1=Obvious, 2=Intermediate, 3=Subtle
    Category   FlawCategory // missing_component, wrong_connection, bottleneck, etc.
    AIHint     string       // Scenario AI uses to expose this flaw
    FixType    FlawFixType  // add_node, remove_node, rewire_edge, etc.
    FixTargets []string     // Component names that constitute a fix
}
```

## Frequently Asked Questions

**Q: How does DeepSkill handle real-time streaming responses during WebSocket interviews?**
A: The `GroqService.GenerateDefenseQuestionStream()` method makes an HTTP request to Groq with `stream: true`, then reads SSE chunks via `bufio.Scanner`. Each `data: ` line is parsed as a `GroqStreamChunk`, and the delta content is passed to an `onToken StreamCallback` function. The WebSocket handler uses this callback to send `stream_chunk` messages to the client in real-time. If no API key is set, it falls back to a mock response with simulated 25ms delays between words.

**Q: How does the adaptive difficulty system work?**
A: The `ChatSession` tracks `DifficultyLevel` (normal/hard/expert/easier) and `DifficultyScore`. The system prompt changes based on difficulty -- "hard" asks about edge cases and specific numbers ("At 100K QPS, what's your P99 latency?"), "expert" probes distributed consensus and CRDTs, "easier" gives gentle hints. The chaos engine's 30% injection rate also adapts based on message count and time since last chaos event.

**Q: What domains does DeepSkill support and how are they different?**
A: Five domains: System Design (Staff Engineer persona, diagram canvas), Civil Engineering (IIT Professor, structural canvas), Mechanical Engineering (Chief Design Engineer, process flow), Medical/MBBS (Senior Attending Physician, clinical pathway + virtual patient encounters), MBA (McKinsey Partner, business model canvas). Each has unique AI persona rules, component categories, canvas types, and chaos events.

**Q: How does the flaw tracker determine if a student has fixed a flaw?**
A: `FlawTracker.isFlawFixed()` checks based on `FixType`. For `add_node`, it checks if any of the `FixTargets` appear in the canvas node labels. For `add_edge`, it checks if a connection exists between specified source and target labels. For `rewire_edge`, it verifies the edge now connects to the correct target. For `reorder_nodes`, it checks Y-position ordering. It uses fuzzy string matching (case-insensitive `strings.Contains`).

**Q: How does the virtual patient encounter handle treatment safety?**
A: Each `Treatment` has `IsDangerous` and `IsCorrect` boolean flags. When a student orders a dangerous treatment (e.g., IV push epinephrine instead of IM), `handleGiveTreatment()` sends a `danger_warning` message, applies a -15 point penalty, and does NOT administer the treatment. Correct treatments apply `VitalEffect` changes (HR, BP, SpO2 deltas) to the patient's real-time vitals.

**Q: How does the rubric evaluator go beyond keyword matching?**
A: The `semanticContains()` function maintains a synonym/expansion map. For example, "handles cache miss" maps to synonyms like "fallback to db", "cache miss path", "if not cached". It also checks proximity of concept words (70%+ of words from a concept appearing in the answer counts as a match). The heuristic evaluator additionally rewards depth indicators ("because", "tradeoff", "bottleneck") and concrete numbers ("QPS", "P99", "GB").

**Q: What happens if the Groq API is unavailable?**
A: All LLM calls have fallbacks. `GroqService` checks `s.apiKey == ""` and returns mock responses for each topic (load balancer, cache, database, etc.) with domain-appropriate follow-up questions. The `RubricEvaluator` falls back to `heuristicEvaluate()` which uses synonym matching + depth scoring. The encounter evaluator falls back to `sendBasicEvaluation()` which scores based on critical questions asked and actions performed.

**Q: How does the prompt injection protection work?**
A: At two levels. L1 sanitization in `GradingService.checkSanitization()` scans all submitted node values for injection patterns like "ignore previous", "give me full marks", "pretend you are". The system prompts also sanitize diagram JSON by stripping "SYSTEM", "INSTRUCTION", and "Ignore previous" strings before injecting into the LLM context.

## Design Tradeoffs

| Decision | Chosen | Alternative | Rationale |
|----------|--------|-------------|-----------|
| In-memory session state | Go `sync.RWMutex` map | Redis/PostgreSQL sessions | Sub-millisecond session access for real-time chat; accepted risk of losing active sessions on crash since interviews can reconnect |
| Groq for LLM inference | Groq API (Llama 3.3 + GPT-oss-120b) | OpenAI GPT-4, Anthropic Claude | Groq's speed (sub-200ms inference) is critical for conversational flow; GPT-4 at 2-5s would break the interview rhythm |
| Single Go binary | Gin + gorilla/websocket | Microservices | Interview platform has tightly coupled components (chat + diagram + evaluation); splitting adds latency and complexity for no benefit at current scale |
| Redis Streams for grading | `XADD` to grading queue | Direct sync grading | Async processing prevents grading from blocking the submission response; sync fallback ensures reliability |
| Flawed template pattern | Students fix pre-loaded designs | Blank canvas | More realistic (real engineers debug existing systems); provides structure for evaluation; tests analytical thinking not just recall |
| Socratic AI (never gives answers) | AI only presents problems | AI gives hints/answers | Forces genuine understanding; prevents students from gaming the system by triggering the AI to reveal solutions |
| Domain-specific AI personas | Separate persona per domain | Generic interviewer | Domain experts ask different kinds of questions; a civil engineering professor exposes different flaws than a staff software engineer |

## What Makes This Impressive

1. **Multi-domain assessment engine in Go** -- Not just system design; handles civil, mechanical, medical, and MBA with domain-specific canvas types, AI personas, and evaluation rubrics. The `DomainRegistry` pattern makes adding new domains straightforward.

2. **Real-time WebSocket streaming with reconnection** -- The `WSChatHandler` manages concurrent sessions with `sync.RWMutex`, supports mid-interview reconnection with full state replay, and streams LLM tokens in real-time. Background cleanup prevents memory leaks from abandoned sessions.

3. **Flaw discovery pedagogy** -- The flawed template + flaw tracker + Socratic AI pattern is a novel approach to technical assessment. Instead of asking "design X from scratch," it tests whether students can analyze and fix existing systems -- a more realistic engineering skill.

4. **Virtual patient encounters with real-time vitals** -- The medical encounter system simulates real clinical scenarios with hidden patient data, delayed test results (real-time goroutine delays), dangerous treatment detection, time-based complications, and AI-powered evaluation against detailed clinical rubrics.

5. **Multi-layered evaluation pipeline** -- Combines rubric evaluation (semantic, not keyword-based), chaos injection (tests resilience thinking), diagram analysis (anti-pattern detection), flaw tracking (canvas diff with ideal solution), and reference architecture comparison. No single evaluation method; they complement each other.

6. **Adaptive difficulty with chaos injection** -- The chaos engine targets architectural weaknesses (e.g., injects cache failure if the student has a cache but no replication). The 30% random injection rate keeps interviews unpredictable while the difficulty level adjusts based on student performance.
