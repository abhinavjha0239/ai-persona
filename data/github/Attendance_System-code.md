# Attendance System -- Source Code Reference

## AdaFace Embedder -- Model Loading
The AdaFace embedder downloads and loads the IR50 model from HuggingFace, resolving custom imports by injecting the cache directory into sys.path.
```python
class AdaFaceEmbedder:
    def __init__(self, repo_id: str, device: str = "auto"):
        self.repo_id = repo_id
        self.device = self._resolve_device(device)
        self.model = self._load_model(repo_id).to(self.device).eval()

    def _load_model(self, repo_id: str):
        cache_dir = os.path.expanduser(f"~/.cvlface_cache/{repo_id}")
        os.makedirs(cache_dir, exist_ok=True)
        snapshot_download(repo_id, local_dir=cache_dir,
                          local_dir_use_symlinks=False, resume_download=True)
        if cache_dir not in sys.path:
            sys.path.insert(0, cache_dir)
        os.chdir(cache_dir)
        model = AutoModel.from_pretrained(cache_dir, trust_remote_code=True)
        return model
```

## AdaFace Embedder -- embed_batch
Generates L2-normalized 512-D embeddings from aligned 112x112 face tensors. Handles both single images and batches.
```python
@torch.inference_mode()
def embed_batch(self, imgs: torch.Tensor) -> np.ndarray:
    if imgs.ndim == 3:
        imgs = imgs.unsqueeze(0)
    imgs = imgs.to(self.device)
    feats = self.model(imgs)
    if isinstance(feats, (list, tuple)):
        feats = feats[0]
    feats = torch.nn.functional.normalize(feats, dim=1)
    return feats.detach().cpu().numpy().astype(np.float32)
```

## SCRFD Detector -- Initialization and Detection
Uses InsightFace's FaceAnalysis with detection-only mode. Auto-detects GPU via ONNXRuntime and returns bounding boxes, keypoints, and confidence scores.
```python
class SCRFDDetector(BaseFaceDetector):
    def __init__(self, det_size=(640, 640), det_thresh=0.6):
        self.det_size = det_size
        self.det_thresh = det_thresh
        self.app = FaceAnalysis(allowed_modules=['detection'])
        self.app.prepare(ctx_id=_auto_ctx_id(),
                         det_thresh=det_thresh, det_size=det_size)

    def detect(self, img_bgr: np.ndarray, max_num: int = 0) -> List[Dict]:
        faces = self.app.get(img_bgr, max_num=max_num)
        results = []
        for f in faces:
            item = {
                "bbox": f.bbox.astype(np.float32),
                "kps": None if f.kps is None else f.kps.astype(np.float32),
                "det_score": float(f.det_score)
            }
            results.append(item)
        return results
```

## FAISS Index -- Core Structure and search()
Thread-safe FAISS IndexFlatIP (inner product) index with result caching and L2 normalization. Supports optional GPU acceleration.
```python
class FaceIndex:
    def __init__(self, dim=512, persist_dir="storage", use_gpu=False):
        self.dim = dim
        self.index = faiss.IndexFlatIP(self.dim)
        self.ids: List[str] = []
        self._lock = threading.RLock()
        self._search_cache: Dict[bytes, Tuple[List[Dict], float]] = {}
        self._cache_ttl = 300

    def search(self, embedding: np.ndarray, top_k: int = 3) -> List[Dict]:
        cache_key = embedding.tobytes()
        with self._lock:
            if cache_key in self._search_cache:
                results, timestamp = self._search_cache[cache_key]
                if time.time() - timestamp < self._cache_ttl:
                    return results[:top_k]
            q = self._l2_normalize(embedding)
            k = min(top_k * 2, self.index.ntotal)
            D, I = self.index.search(q[None, :].astype(np.float32), k)
            results = []
            for j, idx in enumerate(I[0]):
                if idx == -1: continue
                results.append({"student_id": self.ids[idx],
                                "score": float(D[0][j]), "index": int(idx)})
            self._search_cache[cache_key] = (results, time.time())
            return results[:top_k]
```

## FAISS Index -- batch_search
Batch search normalizes all query embeddings at once and performs a single FAISS search call for efficient multi-face recognition.
```python
def batch_search(self, embeddings: np.ndarray, top_k: int = 3) -> List[List[Dict]]:
    with self._lock:
        if self.index.ntotal == 0:
            return [[] for _ in range(len(embeddings))]
        queries = self._l2_normalize(embeddings)
        k = min(top_k, self.index.ntotal)
        D, I = self.index.search(queries.astype(np.float32), k)
        batch_results = []
        for i in range(len(embeddings)):
            results = []
            for j, idx in enumerate(I[i]):
                if idx == -1: continue
                results.append({"student_id": self.ids[idx],
                                "score": float(D[i][j]), "index": int(idx)})
            batch_results.append(results)
        return batch_results
```

## BatchSectionIndex -- Scoped Search
Manages per-batch-section FAISS indexes to reduce false positives. Scoped search queries only the relevant index; global search merges results across all.
```python
class BatchSectionIndex:
    def __init__(self, dim=512, persist_dir="storage", use_gpu=False):
        self._indexes: Dict[str, FaceIndex] = {}
        self._load_all_indexes()

    def search(self, embedding, batch=None, section=None, top_k=3):
        if batch is not None and section is not None:
            key = make_batch_section_key(batch, section)
            with self._lock:
                if key in self._indexes:
                    return self._indexes[key].search(embedding, top_k=top_k)
                return []
        else:
            return self._search_all(embedding, top_k=top_k)

    def _search_all(self, embedding, top_k=3):
        all_results = []
        with self._lock:
            for key, index in self._indexes.items():
                if index.count() > 0:
                    results = index.search(embedding, top_k=top_k)
                    for r in results:
                        r["batch_section"] = key
                    all_results.extend(results)
        all_results.sort(key=lambda x: x["score"], reverse=True)
        return all_results[:top_k]
```

## Enrollment Route Handler
Accepts student images, detects faces with SCRFD, generates AdaFace embeddings, and adds them to both the batch-section index and legacy global index. Uses an async rate limiter to prevent OOM during concurrent enrollments.
```python
@router.post("/enroll", response_model=EnrollResponse)
async def enroll_student(student_id: str, batch: str, section: str,
                         name: Optional[str] = None,
                         files: List[UploadFile] = File(...),
                         current_user: User = Depends(require_super_admin)):
    student_id = sanitize_student_id(student_id)
    detector = get_detector()
    embedder = get_embedder()
    bs_index = get_batch_section_index()
    saved = 0; embs = []

    async with InferenceRateLimiter(timeout=900.0):
        for f in files:
            data = await f.read()
            img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
            faces = detector.detect(img, max_num=settings.MAX_FACES_PER_IMAGE)
            for face in faces:
                crop = align_and_crop_112(img, face["kps"])
                t = bgr112_to_rgb_tensor(crop)
                emb = embedder.embed_batch(t)[0]
                embs.append(emb)
                np.save(emb_path, emb); saved += 1

    embs_np = np.stack(embs, axis=0)
    bs_index.add(student_id, embs_np, batch=batch, section=section, save=True)
    StudentCRUD.create(student_id=student_id, batch=batch, section=section)
    return EnrollResponse(student_id=student_id, num_faces_enrolled=saved)
```

## Recognition Route Handler
Processes uploaded images for face recognition. Detects faces, generates embeddings in a batch tensor, searches the scoped or global index, and deduplicates matches per student keeping the highest score.
```python
@router.post("", response_model=RecognizeResponse, dependencies=[Depends(verify_token)])
async def recognize(files: List[UploadFile] = File(...),
                    batch: Optional[str] = None, section: Optional[str] = None):
    use_scoped_search = batch is not None and section is not None
    bs_index = get_batch_section_index()
    detector = get_detector(); embedder = get_embedder()

    for f in files:
        img = cv2.imdecode(np.frombuffer(await f.read(), np.uint8), cv2.IMREAD_COLOR)
        faces = detector.detect(img, max_num=settings.MAX_FACES_PER_IMAGE)
        tensors = [bgr112_to_rgb_tensor(align_and_crop_112(img, face["kps"]))
                   for face in faces if face["kps"] is not None]
        embs = embedder.embed_batch(torch.stack(tensors))
        for emb in embs:
            results = bs_index.search(emb, batch=batch, section=section, top_k=settings.TOP_K)
            filtered = [r for r in results if r["score"] >= settings.SIMILARITY_THRESHOLD]

    # Deduplicate: keep best match per student
    best = {}
    for r in agg_results:
        sid = r["student_id"]
        if sid not in best or r["score"] > best[sid]["score"]:
            best[sid] = r
    return RecognizeResponse(matches=sorted(matches, key=lambda m: m.score, reverse=True))
```

## WebSocket Connection Manager
Singleton manager that tracks active WebSocket connections, handles message broadcasting, and collects per-connection statistics like messages sent/received.
```python
class ConnectionManager:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
        return cls._instance

    async def connect(self, websocket, connection_id, client_info=None):
        await websocket.accept()
        self.active_connections[connection_id] = websocket
        self.connection_metadata[connection_id] = {
            "connected_at": datetime.now(), "messages_sent": 0,
            "messages_received": 0, "last_activity": datetime.now()
        }

    async def send_message(self, connection_id, message: WSMessage) -> bool:
        websocket = self.active_connections[connection_id]
        message_dict = message.model_dump(mode="json")
        await websocket.send_json(message_dict)
        self.stats["total_messages_sent"] += 1
        return True

    async def broadcast(self, message, exclude=None) -> int:
        sent_count = 0
        for connection_id in list(self.active_connections.keys()):
            if connection_id not in (exclude or set()):
                if await self.send_message(connection_id, message):
                    sent_count += 1
        return sent_count
```

## WebSocket Real-Time Recognition
The WebSocket endpoint authenticates via query token, creates a per-session RecognitionService, and processes binary image frames in a loop, returning JSON recognition results with bounding boxes and match scores.
```python
@router.websocket("/recognize")
async def websocket_recognize(websocket: WebSocket, token: str = Query(...),
                               enhancement: bool = True, preset: str = "default"):
    if token != settings.AUTH_TOKEN:
        await websocket.close(code=1008, reason="Invalid authentication token")
        return
    connection_id = str(uuid.uuid4())
    manager = get_connection_manager()
    recognition_service = RecognitionService(use_enhancement=enhancement)
    await manager.connect(websocket, connection_id)

    while connection_id in manager.active_connections:
        message = await manager.receive_message(connection_id, websocket)
        if message is None: break
        if message.get("type") == "binary":
            image_data = message.get("data")
            result = await recognition_service.process_frame(image_data)
            await manager.send_recognition_result(connection_id, result)
        elif message.get("type") == "ping":
            await manager.send_message(connection_id, WSMessage(type=WSMessageType.PONG))
```
