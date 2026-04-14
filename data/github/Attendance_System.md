# Attendance System -- Face Recognition Microservice

## Quick Summary
A production-grade face recognition microservice built with FastAPI (Python) that automates classroom attendance. Students are enrolled by uploading face photos, which are processed through an AdaFace deep learning pipeline (IR50 backbone, MS1MV2 training data) to produce 512-dimensional embeddings stored in FAISS indexes. To take attendance, a teacher uploads a group/classroom photo; the system detects all faces (SCRFD for real-time, RetinaFace for batch accuracy), generates embeddings, and matches them against enrolled students using cosine similarity (Inner Product on L2-normalized vectors). Supports batch-section scoped indexing to reduce false positives, WebSocket real-time recognition for live webcam feeds, and runs in Docker with Gunicorn + Uvicorn workers.

GitHub repo: `abhinavjha0239/Attendace_System` (note typo in repo name)

## Architecture (Actual File Paths)

```
app/
  main.py                    -- FastAPI app, lifespan manager, router registration
  config.py                  -- Settings class (pydantic-settings), all env vars
  dependencies.py            -- Singleton DI: get_detector(), get_embedder(), get_index()
  schemas.py                 -- Pydantic models: EnrollResponse, Match, RecognizeResponse
  routes/
    students.py              -- POST /students/enroll, GET /students, DELETE /students/{id}
    recognize.py             -- POST /recognize (SCRFD, real-time)
    batch_recognize.py       -- POST /recognize/batch (RetinaFace, high recall)
    websocket_recognize.py   -- WS /ws/recognize (live webcam streaming)
    admin.py                 -- GET /admin/stats
    attendance.py            -- Attendance record management
    subjects.py              -- Subject management
    security.py              -- Bearer token auth, sanitize_student_id(), TeacherScope RBAC
  detector/
    base_detector.py         -- BaseFaceDetector ABC (detect, get_detector_name)
    scrfd_detector.py        -- SCRFDDetector (InsightFace FaceAnalysis, ~120-250ms)
    retinaface_detector.py   -- RetinaFaceDetector (retina-face lib, ~450-850ms)
    multiscale_detector.py   -- MultiScaleDetector (Decorator pattern, NMS merging)
    detector.py              -- Factory: create_detector("scrfd"|"retinaface")
  models/
    adaface_embedder.py      -- AdaFaceEmbedder (HuggingFace AutoModel, 512-D output)
  index/
    faiss_index.py           -- FaceIndex + BatchSectionIndex (FAISS IndexFlatIP)
  utils/
    preprocess.py            -- align_and_crop_112(), bgr112_to_rgb_tensor()
  database/
    models.py                -- SQLAlchemy/SQLite ORM (User, Student tables)
    crud.py                  -- StudentCRUD class
  websocket/                 -- ConnectionManager, WSMessage types
  preprocessing/             -- Image enhancement pipeline
Dockerfile                   -- Multi-stage build, python:3.11-slim, gunicorn
docker-compose.yaml          -- Single service, volume mounts for storage/logs
```

## Technical Details

### AdaFace Embedding Pipeline
The `AdaFaceEmbedder` class in `app/models/adaface_embedder.py` loads the model from HuggingFace (`minchul/cvlface_adaface_ir50_ms1mv2`) using `snapshot_download` and `AutoModel.from_pretrained` with `trust_remote_code=True`. The model is cached at `~/.cvlface_cache/`. Inference uses `@torch.inference_mode()`:

```python
@torch.inference_mode()
def embed_batch(self, imgs: torch.Tensor) -> np.ndarray:
    imgs = imgs.to(self.device)
    feats = self.model(imgs)
    if isinstance(feats, (list, tuple)):
        feats = feats[0]
    feats = torch.nn.functional.normalize(feats, dim=1)
    return feats.detach().cpu().numpy().astype(np.float32)
```

Input: aligned 112x112 RGB tensors normalized to [-1,1]. Output: 512-D L2-normalized embeddings.

### Face Detection -- Dual Detector Strategy
Two detectors serve different use cases, both implementing `BaseFaceDetector` ABC:

**SCRFDDetector** (`app/detector/scrfd_detector.py`): Wraps `insightface.app.FaceAnalysis` with `allowed_modules=['detection']`. Auto-detects GPU via ONNXRuntime CUDAExecutionProvider. Returns dicts with `bbox`, `kps` (5 facial keypoints), `det_score`. Default threshold: 0.6.

**RetinaFaceDetector** (`app/detector/retinaface_detector.py`): Uses `retinaface.RetinaFace.detect_faces()`. Requires writing a temp JPEG file since the library only accepts file paths. Extracts 5-point landmarks (right_eye, left_eye, nose, mouth_right, mouth_left). Default threshold: 0.9.

**MultiScaleDetector** (`app/detector/multiscale_detector.py`): Decorator pattern wrapping any `BaseFaceDetector`. Runs detection at multiple scales (e.g., [0.5, 0.75, 1.0, 1.5, 2.0]), transforms bboxes back to original coordinates, and merges with custom NMS (IoU-based suppression).

### FAISS Indexing
`FaceIndex` in `app/index/faiss_index.py` uses `faiss.IndexFlatIP` (Inner Product on L2-normalized vectors = cosine similarity). Thread-safe via `threading.RLock`. Features:

- **Search caching**: Results cached with `cache_key = embedding.tobytes()`, TTL 300s
- **Batch search**: `batch_search()` for processing multiple face embeddings at once
- **Index optimization**: For 10k+ vectors, rebuilds as `IndexIVFFlat` with sqrt(n) clusters
- **Persistence**: Saves `index.faiss` + `meta.json` (IDs, stats) to disk

```python
def search(self, embedding: np.ndarray, top_k: int=3) -> List[Dict]:
    q = self._l2_normalize(embedding)
    k = min(top_k * 2, self.index.ntotal)
    D, I = self.index.search(q[None, :].astype(np.float32), k)
    results = []
    for j, idx in enumerate(I[0]):
        if idx == -1: continue
        results.append({"student_id": self.ids[idx], "score": float(D[0][j])})
```

**BatchSectionIndex**: Manages multiple `FaceIndex` instances keyed by `{batch}_{section}`. Scoped search limits FAISS queries to a single batch/section (fewer false positives). Falls back to global search across all indexes when batch/section not provided.

### Face Preprocessing
`app/utils/preprocess.py` -- Two critical functions:
- `align_and_crop_112(img_bgr, kps)`: Uses InsightFace's `face_align.norm_crop` to align face to 112x112 using 5 keypoints.
- `bgr112_to_rgb_tensor(img_bgr_112)`: BGR->RGB, normalize to [0,1], then to [-1,1], permute to CHW tensor.

### Enrollment Flow (POST /students/enroll)
1. Validate student_id (regex `^[a-zA-Z0-9_-]+$`), batch, section
2. Check for duplicate via `StudentCRUD.get_by_student_id()`
3. For each uploaded image: decode -> detect faces -> for each face with keypoints: align_and_crop_112 -> bgr112_to_rgb_tensor -> embed_batch
4. Save cropped JPEG + `.npy` embedding to `storage/embeddings/{batch}_{section}/{student_id}/`
5. Add to BatchSectionIndex (mean template by default, multi-template if `STORE_MULTI_TEMPLATE=True`)
6. Also add to legacy global FaceIndex for backward compat
7. Insert metadata to SQLite via StudentCRUD

### Recognition Flow (POST /recognize)
1. Detect faces in uploaded image (SCRFD for /recognize, RetinaFace for /recognize/batch)
2. Align and crop all faces, batch-generate embeddings
3. Search FAISS index (scoped if batch+section provided, global otherwise)
4. Filter matches by `SIMILARITY_THRESHOLD` (default 0.38)
5. Deduplicate: keep highest score per student_id
6. Return sorted matches with bboxes

### WebSocket Real-Time Recognition (WS /ws/recognize)
`RecognitionService` class processes binary frames. Clients send JPEG bytes; server returns JSON with matches, all_faces, processing_time_ms. Supports ping/pong keepalive, stats queries, and image enhancement presets (default, aggressive, light, blur_focus, small_face). Managed by `ConnectionManager` singleton.

### Security & Auth
`app/routes/security.py` implements Bearer token auth via `HTTPBearer`. Role-based access: `require_super_admin` for enrollment/deletion, `get_teacher_scope` with `TeacherScope` for batch-limited access. Input sanitization: `sanitize_student_id()` rejects path traversal.

### Docker Setup
Multi-stage Dockerfile: builder stage installs build-essential+cmake for native deps; production stage uses python:3.11-slim with OpenCV runtime libs. Non-root user (`appuser`). Production runs Gunicorn with 4 UvicornWorkers, max-requests 10000 with jitter, 60s timeout. Healthcheck: `curl -f http://localhost:8000/health`.

### Key Configuration (Settings class)
| Setting | Default | Description |
|---|---|---|
| SIMILARITY_THRESHOLD | 0.38 | Cosine similarity cutoff |
| DET_THRESHOLD | 0.6 | SCRFD detection confidence |
| RETINAFACE_THRESHOLD | 0.9 | RetinaFace detection confidence |
| EMBEDDING_DIM | 512 | AdaFace output dimension |
| MAX_FACES_PER_IMAGE | 50 | Cap per photo |
| DETECTOR_TYPE | scrfd | Default real-time detector |
| BATCH_DETECTOR_TYPE | retinaface | Default batch detector |
| ADA_MODEL_REPO | minchul/cvlface_adaface_ir50_ms1mv2 | HuggingFace model ID |

## Frequently Asked Questions

### Q1: How does the system handle multiple photos for the same student during enrollment?
By default (`STORE_MULTI_TEMPLATE=False`), the system calls `add_mean_template()` which computes `np.mean(embeddings, axis=0)` across all detected face crops and stores a single averaged 512-D embedding. If `STORE_MULTI_TEMPLATE=True`, all individual embeddings are stored (one FAISS entry per crop). Mean template is more space-efficient and reduces noise; multi-template can handle varied poses better.

### Q2: Why use two different face detectors (SCRFD vs RetinaFace)?
SCRFD (via InsightFace FaceAnalysis) runs at ~120-250ms/image and is optimized for real-time/webcam use. RetinaFace runs at ~450-850ms but has ~93% recall vs SCRFD's ~85% -- critical for group classroom photos where missing a face means an absent mark. The system exposes separate endpoints: `/recognize` (SCRFD) and `/recognize/batch` (RetinaFace).

### Q3: What does BatchSectionIndex buy over a single global index?
When recognition is scoped to a specific batch+section (e.g., "2024_CS-1"), FAISS only searches that subset's index. In a college with 2000 students, a class of 60 means searching 60 embeddings instead of 2000. This dramatically reduces false positives (fewer similar-looking matches from other classes) and speeds up search.

### Q4: How is face alignment done before embedding?
`align_and_crop_112(img_bgr, kps)` calls InsightFace's `face_align.norm_crop(img_bgr, landmark=kps, image_size=112)`. This uses the 5 facial keypoints (eyes, nose, mouth corners) to apply an affine transformation that standardizes face position, rotation, and scale to a canonical 112x112 crop. The tensor conversion then normalizes pixel values to [-1, 1] as required by AdaFace.

### Q5: How does the WebSocket endpoint handle concurrent connections?
The `ConnectionManager` singleton in `app/websocket/` tracks active connections by UUID. Each connection gets its own `RecognitionService` instance with independent stats tracking (frames_processed, faces_detected, faces_recognized, avg_processing_time_ms). Binary frames are processed with `process_frame()` which handles the full detect->align->embed->search pipeline. The endpoint supports enhancement presets configurable per connection.

### Q6: What happens when the FAISS index grows very large?
`FaceIndex.optimize_index()` triggers when `ntotal >= 10000`. It extracts all vectors, creates an `IndexIVFFlat` with `sqrt(n)` clusters, trains it, and replaces the flat index. Sets `nprobe = max(1, nlist // 10)` for searching 10% of clusters. The `rebuild_index()` method can reconstruct the entire index from saved `.npy` files on disk.

### Q7: How does the system prevent race conditions during concurrent enrollment?
`FaceIndex` uses `threading.RLock()` (reentrant lock) for all mutations (add, remove, search). The enrollment route uses `InferenceRateLimiter` (async context manager) with a 15-minute timeout to serialize GPU-intensive operations and prevent OOM when multiple teachers enroll simultaneously.

### Q8: What is the similarity threshold of 0.38 based on?
The default `SIMILARITY_THRESHOLD=0.38` is the cosine similarity (since embeddings are L2-normalized, Inner Product = cosine similarity). The config warns if threshold < 0.3 (too many false positives) or > 0.5 (too many false negatives). This value was likely tuned empirically for AdaFace IR50 on a college student dataset.

## Design Tradeoffs

1. **IndexFlatIP (exact search) vs IVF/HNSW**: Chose flat index for correctness at small scale (<10k students), with automatic IVF upgrade at 10k+. Avoids training step during enrollment.

2. **Mean template vs multi-template**: Default is mean template (1 embedding per student) for smaller index and faster search. Trades off accuracy on extreme pose variation.

3. **RetinaFace temp-file workaround**: The retina-face Python library only accepts file paths, forcing a `cv2.imwrite` to a temp JPEG per detection. This adds I/O latency but avoids forking the library.

4. **Dual index (batch-section + legacy global)**: Maintains backward compatibility at the cost of double storage. The global index serves as a fallback when batch/section parameters are not provided.

5. **SQLite for metadata vs PostgreSQL**: Uses SQLite (via SQLAlchemy) for student metadata -- simple, zero-config, fits single-server deployment. Would need migration for multi-instance scaling.

6. **Search result caching**: Caches FAISS results keyed by raw embedding bytes with 5-minute TTL. Trades memory for latency on repeated queries (e.g., video frames with similar faces). Cache limited to 1000 entries.

## What Makes This Impressive

- **End-to-end ML pipeline in production**: From face detection (SCRFD/RetinaFace) through alignment (InsightFace norm_crop) to embedding (AdaFace IR50) to similarity search (FAISS) -- all wired into a real API with auth, rate limiting, and Docker deployment.
- **Dual-detector architecture with factory pattern**: SOLID design principles throughout -- `BaseFaceDetector` ABC, factory function, decorator-pattern MultiScaleDetector. Clean separation lets you swap detectors without touching routes.
- **Batch-section scoped FAISS indexes**: Novel approach to reduce false positives in educational settings. Each class gets its own index, searched independently.
- **WebSocket real-time recognition**: Full duplex streaming with per-connection enhancement presets, connection lifecycle management, and detailed performance metrics.
- **Production-ready infrastructure**: Multi-stage Docker build, non-root user, Gunicorn with UvicornWorkers, health checks, structured logging with Loguru rotation/compression, rate limiting for GPU inference.
