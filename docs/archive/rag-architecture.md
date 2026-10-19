# Tuning Knowledge RAG Architecture

## Overview

This document outlines the architecture for converting engine tuning video content into a searchable knowledge base that Kiro can query via MCP (Model Context Protocol) during tuning sessions.

```
┌─────────────────────────────────────────────────────────────┐
│                    INGESTION PIPELINE                         │
│                                                              │
│  Video Files → Whisper Transcription → Chunking → Embedding  │
│                                                              │
│  Output: ChromaDB vector store with tagged chunks            │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                    MCP SERVER                                 │
│                                                              │
│  Kiro ←→ tuning-knowledge-mcp ←→ ChromaDB (local)           │
│                                                              │
│  Tools: search_knowledge, get_context, list_topics           │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Transcription Pipeline

### Tool: OpenAI Whisper (local or API)

```bash
# Install Whisper locally (runs on Apple Silicon GPU via MLX)
pip install mlx-whisper

# Or use the original OpenAI whisper
pip install openai-whisper
```

### Transcription Script

```python
#!/usr/bin/env python3
"""
transcribe_videos.py — Batch transcribe tuning videos to text with timestamps.
"""
import os
import json
import whisper
from pathlib import Path

# Configuration
VIDEO_DIR = Path("./videos")          # Your video files
OUTPUT_DIR = Path("./transcripts")    # Output JSON transcripts
MODEL_SIZE = "large-v3"               # Best accuracy for technical content

def transcribe_video(video_path, model):
    """Transcribe a single video file with word-level timestamps."""
    result = model.transcribe(
        str(video_path),
        language="en",
        word_timestamps=True,
        verbose=False
    )
    return result

def save_transcript(result, video_path, output_dir):
    """Save transcript as JSON with metadata."""
    output = {
        "source_file": video_path.name,
        "duration_seconds": result.get("duration", 0),
        "segments": []
    }
    
    for segment in result["segments"]:
        output["segments"].append({
            "start": segment["start"],
            "end": segment["end"],
            "text": segment["text"].strip(),
        })
    
    out_path = output_dir / (video_path.stem + ".json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"  Saved: {out_path}")

def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    
    print(f"Loading Whisper model: {MODEL_SIZE}")
    model = whisper.load_model(MODEL_SIZE)
    
    video_extensions = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v"}
    videos = [f for f in VIDEO_DIR.iterdir() if f.suffix.lower() in video_extensions]
    
    print(f"Found {len(videos)} videos to transcribe")
    
    for i, video in enumerate(sorted(videos), 1):
        print(f"[{i}/{len(videos)}] Transcribing: {video.name}")
        result = transcribe_video(video, model)
        save_transcript(result, video, OUTPUT_DIR)

if __name__ == "__main__":
    main()
```

### Post-Transcription Cleanup

Technical terms Whisper commonly gets wrong:

| Whisper Output | Correct Term |
|---|---|
| "lambda" (correct) | Lambda |
| "ve table" / "v table" | VE table |
| "motec" / "mo tech" | MoTeC |
| "d b t d c" | dBTDC |
| "h p f p" | HPFP |
| "x d i" | XDI |
| "stoic" / "stoich" | Stoichiometric |
| "k p a" | kPa |

```python
"""
fix_terminology.py — Post-process transcripts to correct technical terms.
"""
import json
import re
from pathlib import Path

CORRECTIONS = {
    r'\bmo\s*tech\b': 'MoTeC',
    r'\bmo\s*tec\b': 'MoTeC',
    r'\bv\s*e\s*table\b': 'VE table',
    r'\bd\s*b\s*t\s*d\s*c\b': 'dBTDC',
    r'\bh\s*p\s*f\s*p\b': 'HPFP',
    r'\bx\s*d\s*i\b': 'XDI',
    r'\bk\s*p\s*a\b': 'kPa',
    r'\ba\s*f\s*r\b': 'AFR',
    r'\bl\s*t\s*4\b': 'LT4',
    r'\bl\s*t\s*1\b': 'LT1',
    r'\bstoic\b': 'stoichiometric',
}

def fix_text(text):
    for pattern, replacement in CORRECTIONS.items():
        text = re.sub(pattern, replacement, text, flags=re.IGNORECASE)
    return text

def process_transcript(path):
    with open(path) as f:
        data = json.load(f)
    
    for segment in data["segments"]:
        segment["text"] = fix_text(segment["text"])
    
    with open(path, "w") as f:
        json.dump(data, f, indent=2)

# Process all transcripts
for path in Path("./transcripts").glob("*.json"):
    process_transcript(path)
    print(f"Fixed: {path.name}")
```

---

## Phase 2: Chunking Strategy

### Topic-Based Chunking

Rather than fixed-size chunks, group consecutive transcript segments by topic coherence. A chunk should represent one complete thought or technique (30 seconds to 3 minutes of content).

```python
"""
chunk_transcripts.py — Split transcripts into topic-based chunks with metadata.
"""
import json
from pathlib import Path

# Configuration
TRANSCRIPT_DIR = Path("./transcripts")
CHUNKS_DIR = Path("./chunks")
MIN_CHUNK_SECONDS = 30      # Minimum chunk duration
MAX_CHUNK_SECONDS = 180     # Maximum chunk duration
OVERLAP_SECONDS = 10        # Overlap between chunks for context continuity

# Topic keywords for auto-tagging
TOPIC_KEYWORDS = {
    "ve_table": ["ve table", "volumetric efficiency", "ve correction", "ve map"],
    "knock": ["knock", "detonation", "knock sensor", "timing retard", "knock frequency"],
    "fuel_pressure": ["fuel pressure", "hpfp", "rail pressure", "fuel pump", "pressure aim"],
    "idle": ["idle", "idle hang", "decel", "idle speed", "idle control"],
    "injector": ["injector", "pulse width", "injection timing", "xdi", "lean spike"],
    "lambda": ["lambda", "afr", "air fuel", "stoichiometric", "rich", "lean"],
    "ignition": ["ignition", "spark", "timing", "advance", "retard", "mbt"],
    "boost": ["boost", "supercharger", "turbo", "wastegate", "boost control"],
    "closed_loop": ["closed loop", "cl trim", "fuel trim", "long term", "short term"],
    "general": ["tuning", "calibration", "dyno", "data log", "motec"],
}

def detect_topics(text):
    """Auto-detect topics from chunk text."""
    text_lower = text.lower()
    topics = []
    for topic, keywords in TOPIC_KEYWORDS.items():
        for kw in keywords:
            if kw in text_lower:
                topics.append(topic)
                break
    return topics if topics else ["general"]

def chunk_transcript(transcript_path):
    """Split a transcript into overlapping topic-based chunks."""
    with open(transcript_path) as f:
        data = json.load(f)
    
    segments = data["segments"]
    source_file = data["source_file"]
    chunks = []
    
    i = 0
    while i < len(segments):
        # Start a new chunk
        chunk_start = segments[i]["start"]
        chunk_text_parts = []
        chunk_end = chunk_start
        
        # Accumulate segments until we hit max duration
        while i < len(segments):
            seg = segments[i]
            chunk_end = seg["end"]
            chunk_text_parts.append(seg["text"])
            
            duration = chunk_end - chunk_start
            if duration >= MAX_CHUNK_SECONDS:
                break
            i += 1
        
        # Only create chunk if it meets minimum duration
        duration = chunk_end - chunk_start
        if duration >= MIN_CHUNK_SECONDS or i >= len(segments):
            chunk_text = " ".join(chunk_text_parts)
            topics = detect_topics(chunk_text)
            
            chunks.append({
                "source_file": source_file,
                "start_time": chunk_start,
                "end_time": chunk_end,
                "duration": duration,
                "text": chunk_text,
                "topics": topics,
            })
        
        # Move forward, but overlap by OVERLAP_SECONDS
        # Find the segment that starts OVERLAP_SECONDS before chunk_end
        overlap_target = chunk_end - OVERLAP_SECONDS
        while i < len(segments) and segments[i]["start"] < overlap_target:
            i += 1
        if i == 0:
            i = 1  # Prevent infinite loop
    
    return chunks

def main():
    CHUNKS_DIR.mkdir(exist_ok=True)
    
    all_chunks = []
    for transcript_path in sorted(TRANSCRIPT_DIR.glob("*.json")):
        print(f"Chunking: {transcript_path.name}")
        chunks = chunk_transcript(transcript_path)
        all_chunks.extend(chunks)
        print(f"  → {len(chunks)} chunks")
    
    # Save all chunks
    output_path = CHUNKS_DIR / "all_chunks.json"
    with open(output_path, "w") as f:
        json.dump(all_chunks, f, indent=2)
    
    print(f"\nTotal chunks: {len(all_chunks)}")
    print(f"Saved to: {output_path}")

if __name__ == "__main__":
    main()
```

---

## Phase 3: Embedding & Vector Store

### Using ChromaDB (local, no cloud dependency)

```bash
pip install chromadb sentence-transformers
```

```python
"""
build_vector_store.py — Embed chunks and store in ChromaDB.
"""
import json
import chromadb
from chromadb.utils import embedding_functions
from pathlib import Path

CHUNKS_PATH = Path("./chunks/all_chunks.json")
DB_PATH = Path("./vector_db")

def main():
    # Load chunks
    with open(CHUNKS_PATH) as f:
        chunks = json.load(f)
    
    print(f"Loaded {len(chunks)} chunks")
    
    # Initialize ChromaDB with persistent storage
    client = chromadb.PersistentClient(path=str(DB_PATH))
    
    # Use a good embedding model for technical content
    # all-MiniLM-L6-v2 is fast; all-mpnet-base-v2 is more accurate
    embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
        model_name="all-mpnet-base-v2"
    )
    
    # Create or get collection
    collection = client.get_or_create_collection(
        name="tuning_knowledge",
        embedding_function=embedding_fn,
        metadata={"description": "Engine tuning video transcripts"}
    )
    
    # Add chunks in batches
    BATCH_SIZE = 100
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i:i + BATCH_SIZE]
        
        ids = [f"chunk_{i + j}" for j in range(len(batch))]
        documents = [c["text"] for c in batch]
        metadatas = [{
            "source_file": c["source_file"],
            "start_time": c["start_time"],
            "end_time": c["end_time"],
            "duration": c["duration"],
            "topics": ",".join(c["topics"]),
        } for c in batch]
        
        collection.add(
            ids=ids,
            documents=documents,
            metadatas=metadatas
        )
        
        print(f"  Added batch {i // BATCH_SIZE + 1} ({len(batch)} chunks)")
    
    print(f"\nVector store built at: {DB_PATH}")
    print(f"Total documents: {collection.count()}")

if __name__ == "__main__":
    main()
```

---

## Phase 4: MCP Server

### Server Implementation

```python
"""
tuning_knowledge_mcp/server.py — MCP server for querying the tuning knowledge base.
"""
import json
import chromadb
from chromadb.utils import embedding_functions
from mcp.server import Server
from mcp.types import Tool, TextContent
from pathlib import Path

# Configuration
DB_PATH = Path(__file__).parent / "vector_db"
COLLECTION_NAME = "tuning_knowledge"
DEFAULT_N_RESULTS = 5

# Initialize
app = Server("tuning-knowledge")

# ChromaDB client (lazy init)
_client = None
_collection = None

def get_collection():
    global _client, _collection
    if _collection is None:
        _client = chromadb.PersistentClient(path=str(DB_PATH))
        embedding_fn = embedding_functions.SentenceTransformerEmbeddingFunction(
            model_name="all-mpnet-base-v2"
        )
        _collection = _client.get_collection(
            name=COLLECTION_NAME,
            embedding_function=embedding_fn
        )
    return _collection


@app.tool()
async def search_knowledge(query: str, n_results: int = 5, topic_filter: str = "") -> str:
    """
    Search the tuning knowledge base for relevant information.
    
    Args:
        query: Natural language question or topic to search for
        n_results: Number of results to return (default 5, max 10)
        topic_filter: Optional comma-separated topic filter 
                      (ve_table, knock, fuel_pressure, idle, injector, 
                       lambda, ignition, boost, closed_loop, general)
    """
    collection = get_collection()
    n_results = min(max(1, n_results), 10)
    
    # Build where filter if topic specified
    where_filter = None
    if topic_filter:
        topics = [t.strip() for t in topic_filter.split(",")]
        if len(topics) == 1:
            where_filter = {"topics": {"$contains": topics[0]}}
    
    # Query
    results = collection.query(
        query_texts=[query],
        n_results=n_results,
        where=where_filter,
        include=["documents", "metadatas", "distances"]
    )
    
    # Format results
    output_parts = []
    for i, (doc, meta, dist) in enumerate(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0]
    )):
        relevance = max(0, 1 - dist)  # Convert distance to relevance score
        source = meta.get("source_file", "unknown")
        start = meta.get("start_time", 0)
        topics = meta.get("topics", "")
        
        # Format timestamp as MM:SS
        minutes = int(start) // 60
        seconds = int(start) % 60
        timestamp = f"{minutes}:{seconds:02d}"
        
        output_parts.append(
            f"[Result {i+1}] (relevance: {relevance:.2f})\n"
            f"Source: {source} @ {timestamp}\n"
            f"Topics: {topics}\n"
            f"Content: {doc}\n"
        )
    
    if not output_parts:
        return "No relevant results found for this query."
    
    return "\n---\n".join(output_parts)


@app.tool()
async def list_topics() -> str:
    """List all available topics in the knowledge base with document counts."""
    collection = get_collection()
    
    # Get all metadata to count topics
    all_meta = collection.get(include=["metadatas"])
    
    topic_counts = {}
    for meta in all_meta["metadatas"]:
        topics = meta.get("topics", "").split(",")
        for topic in topics:
            topic = topic.strip()
            if topic:
                topic_counts[topic] = topic_counts.get(topic, 0) + 1
    
    # Sort by count descending
    sorted_topics = sorted(topic_counts.items(), key=lambda x: -x[1])
    
    lines = ["Available topics in the tuning knowledge base:\n"]
    for topic, count in sorted_topics:
        lines.append(f"  {topic}: {count} chunks")
    lines.append(f"\nTotal documents: {collection.count()}")
    
    return "\n".join(lines)


@app.tool()
async def get_context(source_file: str, start_time: float = 0, duration: float = 300) -> str:
    """
    Get extended context from a specific video source around a timestamp.
    Useful for getting more detail after finding a relevant search result.
    
    Args:
        source_file: The video filename (from search results)
        start_time: Start time in seconds to retrieve from
        duration: How many seconds of content to retrieve (default 300 = 5 min)
    """
    collection = get_collection()
    
    # Query by metadata filter
    results = collection.get(
        where={
            "$and": [
                {"source_file": {"$eq": source_file}},
                {"start_time": {"$gte": start_time}},
                {"start_time": {"$lte": start_time + duration}},
            ]
        },
        include=["documents", "metadatas"]
    )
    
    if not results["documents"]:
        return f"No content found for {source_file} at {start_time}s"
    
    # Sort by start_time and concatenate
    paired = list(zip(results["documents"], results["metadatas"]))
    paired.sort(key=lambda x: x[1].get("start_time", 0))
    
    parts = []
    for doc, meta in paired:
        start = meta.get("start_time", 0)
        minutes = int(start) // 60
        seconds = int(start) % 60
        parts.append(f"[{minutes}:{seconds:02d}] {doc}")
    
    return f"Context from: {source_file}\n\n" + "\n\n".join(parts)


if __name__ == "__main__":
    import asyncio
    from mcp.server.stdio import stdio_server
    
    async def main():
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream)
    
    asyncio.run(main())
```

### Package Structure

```
tuning-knowledge-mcp/
├── pyproject.toml
├── server.py
├── vector_db/           ← ChromaDB persistent storage (generated)
└── README.md
```

### pyproject.toml

```toml
[project]
name = "tuning-knowledge-mcp"
version = "1.0.0"
description = "MCP server for engine tuning knowledge base"
requires-python = ">=3.10"
dependencies = [
    "mcp>=1.0.0",
    "chromadb>=0.4.0",
    "sentence-transformers>=2.2.0",
]

[project.scripts]
tuning-knowledge-mcp = "server:main"
```

---

## Phase 5: Kiro Integration

### MCP Configuration

Add to `.kiro/settings/mcp.json`:

```json
{
  "mcpServers": {
    "tuning-knowledge": {
      "command": "python",
      "args": ["/path/to/tuning-knowledge-mcp/server.py"],
      "env": {},
      "disabled": false,
      "autoApprove": ["search_knowledge", "list_topics", "get_context"]
    }
  }
}
```

### Usage Examples

Once configured, you can ask things like:

- "Search the tuning knowledge for how to set up knock detection on the LT4"
- "What does the training material say about idle hang on cold start?"
- "Find guidance on fuel pressure aim table strategy for boosted engines"
- "Get more context from that HPA Academy video about VE table corrections"

The MCP server will retrieve the most relevant transcript segments and I'll use them to give you specific, experience-based answers grounded in your training content.

---

## Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| Whisper transcription | 8GB RAM, any CPU (slow) | Apple Silicon M1+ or NVIDIA GPU |
| Embedding generation | 4GB RAM | 8GB+ RAM (faster batch processing) |
| ChromaDB storage | ~1MB per hour of video | SSD for fast queries |
| MCP server runtime | 2GB RAM | 4GB RAM (model stays loaded) |

### Time Estimates

| Step | Per Hour of Video |
|---|---|
| Whisper transcription (M1 Mac / NVIDIA GPU) | ~5–10 minutes |
| Whisper transcription (Intel CPU only) | ~30–60 minutes |
| Whisper transcription (faster-whisper, Intel CPU) | ~15–30 minutes |
| Chunking + embedding | ~1–2 minutes |
| Total pipeline (Apple Silicon / GPU) | ~10–15 min/hour |
| Total pipeline (Intel CPU) | ~35–65 min/hour |

---

## Linux (Ubuntu) Intel CPU Setup

If you're running on an Intel CPU Ubuntu machine without an NVIDIA GPU, use `faster-whisper` — it's a CTranslate2-based reimplementation that runs 2–4× faster than the original Whisper on CPU.

### System Prerequisites

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Python 3.10+ and pip
sudo apt install -y python3 python3-pip python3-venv

# Install ffmpeg (required for audio extraction from video)
sudo apt install -y ffmpeg

# Verify
python3 --version   # Should be 3.10+
ffmpeg -version     # Should show version info
```

### Create a Virtual Environment

```bash
mkdir -p ~/tuning-rag && cd ~/tuning-rag
python3 -m venv .venv
source .venv/bin/activate
```

### Install faster-whisper (Optimized for CPU)

```bash
# faster-whisper uses CTranslate2 which has optimized Intel CPU kernels (AVX2/AVX-512)
pip install faster-whisper
```

### Transcription Script (faster-whisper, CPU-optimized)

Save as `~/tuning-rag/transcribe_videos.py`:

```python
#!/usr/bin/env python3
"""
transcribe_videos.py — Batch transcribe tuning videos using faster-whisper on CPU.
Optimized for Intel Ubuntu systems without GPU.
"""
import os
import json
import sys
from pathlib import Path
from faster_whisper import WhisperModel

# Configuration
VIDEO_DIR = Path("./videos")          # Put your video files here
OUTPUT_DIR = Path("./transcripts")    # Output JSON transcripts
MODEL_SIZE = "large-v3"               # Options: tiny, base, small, medium, large-v3
CPU_THREADS = 0                       # 0 = auto-detect (uses all cores)
BEAM_SIZE = 5                         # Higher = more accurate but slower

def transcribe_video(video_path, model):
    """Transcribe a single video file with timestamps."""
    segments, info = model.transcribe(
        str(video_path),
        language="en",
        beam_size=BEAM_SIZE,
        word_timestamps=False,      # Segment-level is sufficient and faster
        vad_filter=True,            # Skip silence (speeds up processing)
        vad_parameters=dict(
            min_silence_duration_ms=500,
        ),
    )
    
    # Collect segments (generator must be consumed)
    result_segments = []
    for segment in segments:
        result_segments.append({
            "start": round(segment.start, 2),
            "end": round(segment.end, 2),
            "text": segment.text.strip(),
        })
    
    return {
        "language": info.language,
        "duration_seconds": info.duration,
        "segments": result_segments,
    }

def save_transcript(result, video_path, output_dir):
    """Save transcript as JSON with metadata."""
    output = {
        "source_file": video_path.name,
        "duration_seconds": result["duration_seconds"],
        "language": result["language"],
        "segments": result["segments"],
    }
    
    out_path = output_dir / (video_path.stem + ".json")
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    
    print(f"  Saved: {out_path} ({len(result['segments'])} segments)")

def format_duration(seconds):
    """Format seconds as HH:MM:SS."""
    h = int(seconds) // 3600
    m = (int(seconds) % 3600) // 60
    s = int(seconds) % 60
    return f"{h}:{m:02d}:{s:02d}"

def main():
    OUTPUT_DIR.mkdir(exist_ok=True)
    VIDEO_DIR.mkdir(exist_ok=True)
    
    # Check for videos
    video_extensions = {".mp4", ".mkv", ".avi", ".mov", ".webm", ".m4v", ".flv", ".wmv"}
    videos = [f for f in VIDEO_DIR.iterdir() if f.suffix.lower() in video_extensions]
    
    if not videos:
        print(f"No video files found in {VIDEO_DIR.resolve()}")
        print(f"Supported formats: {', '.join(sorted(video_extensions))}")
        sys.exit(1)
    
    # Calculate total duration estimate
    print(f"Found {len(videos)} videos to transcribe")
    print(f"Model: {MODEL_SIZE} (CPU mode, {CPU_THREADS or 'auto'} threads)")
    print(f"This will take approximately 30-60 minutes per hour of video on Intel CPU")
    print()
    
    # Load model (downloads on first run, ~3GB for large-v3)
    print(f"Loading model: {MODEL_SIZE} ...")
    print("  (First run downloads the model — this is a one-time ~3GB download)")
    model = WhisperModel(
        MODEL_SIZE,
        device="cpu",
        compute_type="int8",        # int8 quantization: 2x faster on CPU, minimal quality loss
        cpu_threads=CPU_THREADS,
    )
    print("  Model loaded.\n")
    
    # Process each video
    for i, video in enumerate(sorted(videos), 1):
        size_mb = video.stat().st_size / (1024 * 1024)
        print(f"[{i}/{len(videos)}] {video.name} ({size_mb:.0f} MB)")
        
        # Skip if already transcribed
        out_path = OUTPUT_DIR / (video.stem + ".json")
        if out_path.exists():
            print(f"  Skipping (already transcribed)")
            continue
        
        try:
            result = transcribe_video(video, model)
            save_transcript(result, video, OUTPUT_DIR)
            duration = format_duration(result["duration_seconds"])
            print(f"  Duration: {duration}")
        except Exception as e:
            print(f"  ERROR: {e}")
            continue
    
    print("\nDone! Transcripts saved to:", OUTPUT_DIR.resolve())

if __name__ == "__main__":
    main()
```

### Running the Transcription

```bash
cd ~/tuning-rag
source .venv/bin/activate

# Put your video files in the videos/ directory
cp /path/to/your/tuning-videos/*.mp4 ./videos/

# Run transcription
python transcribe_videos.py
```

### Performance Tips for Intel CPU

1. **Use `int8` compute type** (already set in the script) — quantizes the model to 8-bit integers, roughly 2× faster with negligible quality loss on the `large-v3` model.

2. **Use `medium` model if `large-v3` is too slow** — the medium model is ~3× faster with slightly lower accuracy. Change `MODEL_SIZE = "medium"` in the script. For technical content with clear audio, medium is usually sufficient.

3. **Enable VAD filter** (already set) — Voice Activity Detection skips silent portions of the video, which can save 10–30% processing time on videos with pauses.

4. **Process overnight** — if you have many hours of content, start the batch before bed. The script skips already-transcribed files, so you can interrupt and resume.

5. **Check your CPU features:**
   ```bash
   # Check for AVX2 support (faster-whisper benefits significantly)
   lscpu | grep avx2
   
   # Check core count (all cores are used by default)
   nproc
   ```

6. **Monitor resource usage:**
   ```bash
   # In another terminal, watch CPU and memory
   htop
   ```

### Model Size vs Speed Trade-off (Intel CPU)

| Model | Size | Speed (per hour of audio) | Accuracy |
|---|---|---|---|
| `tiny` | 75 MB | ~3 min | Low (misses technical terms) |
| `base` | 142 MB | ~5 min | Fair |
| `small` | 466 MB | ~12 min | Good |
| `medium` | 1.5 GB | ~25 min | Very good |
| `large-v3` | 3.1 GB | ~50 min | Best (recommended for technical content) |

For engine tuning content with specific terminology, `large-v3` with `int8` quantization gives the best results. If time is a constraint, `medium` is a reasonable compromise.

### After Transcription: Continue the Pipeline

Once transcripts are generated, the remaining steps (terminology fix, chunking, embedding, MCP server) are the same regardless of platform. Continue from Phase 2 in the main architecture document above.

---

## Incremental Updates

To add new videos later:

```bash
# 1. Transcribe new videos only
python transcribe_videos.py --new-only

# 2. Fix terminology
python fix_terminology.py

# 3. Chunk new transcripts
python chunk_transcripts.py --incremental

# 4. Add to vector store
python build_vector_store.py --append
```

The ChromaDB store supports incremental additions without rebuilding the entire index.

---

## Alternative: Simpler Approach (No Vector DB)

If you want to start simpler before committing to the full pipeline, you could:

1. Transcribe videos with Whisper
2. Save transcripts as markdown files in a `.kiro/knowledge/` directory
3. Use Kiro's steering files to reference them: `#[[file:knowledge/video-name.md]]`

This gives you manual retrieval (you pick which transcript to include) without the automated semantic search. Good for testing whether the content is useful before building the full RAG infrastructure.
