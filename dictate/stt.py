"""Microphone capture + local speech-to-text for the voice-dictate mod.

Protocol (stdout, one JSON object per line):
  {"type": "ready", "model": ..., "device": ...}   model loaded, mic open
  {"type": "text", "text": ...}                     one transcribed phrase
  {"type": "error", "message": ...}                 fatal problem, then exit 1
  {"type": "done"}                                  stopped cleanly, then exit 0

Stop: the parent creates the file named by --stop-file. Whatever audio is
still buffered is transcribed and emitted before exiting.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import sys
import time

SAMPLE_RATE = 16_000
BLOCK_MS = 30
BLOCK = SAMPLE_RATE * BLOCK_MS // 1000
PRE_ROLL_BLOCKS = 10  # 300 ms kept before speech starts
MIN_SPEECH_S = 0.35
STOP_POLL_BLOCKS = 5

# Whisper's usual output on silence / noise, dropped if it is the whole phrase.
HALLUCINATIONS = {
    "thank you.", "thanks for watching.", "thank you for watching.",
    "subtítulos realizados por la comunidad de amara.org",
    "subtitulos por la comunidad de amara.org",
    "gracias.", "¡gracias!", "gracias por ver el video.", "you", "bye.",
}


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message: str) -> None:
    emit({"type": "error", "message": message})
    sys.exit(1)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--model", default="small")
    p.add_argument("--language", default="auto")
    p.add_argument("--silence-ms", type=int, default=800)
    p.add_argument("--max-segment-s", type=float, default=25.0)
    p.add_argument("--stop-file", required=True)
    p.add_argument("--device", default="")
    p.add_argument("--wav", default="", help="debug: transcribe this 16 kHz mono WAV instead of the mic and exit")
    return p.parse_args()


def resolve_device(sd, spec: str):
    if not spec:
        return None, sd.query_devices(kind="input")["name"]
    if spec.isdigit():
        index = int(spec)
        return index, sd.query_devices(index)["name"]
    wanted = spec.lower()
    for index, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0 and wanted in dev["name"].lower():
            return index, dev["name"]
    raise ValueError(f"no input device matches {spec!r}")


def main() -> None:
    args = parse_args()

    try:
        import numpy as np
        import sounddevice as sd
        from faster_whisper import WhisperModel
    except ImportError as exc:  # pragma: no cover - depends on the host
        fail(f"missing Python package: {exc.name}. Install faster-whisper, sounddevice and numpy.")
        return

    try:
        device_index, device_name = resolve_device(sd, args.device)
    except Exception as exc:
        fail(f"microphone: {exc}")
        return

    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8")
    except Exception as exc:
        fail(f"could not load whisper model {args.model!r}: {exc}")
        return

    language = None if args.language.lower() in ("", "auto") else args.language

    def transcribe(samples) -> str:
        duration = len(samples) / SAMPLE_RATE
        if duration < MIN_SPEECH_S:
            return ""
        segments, _info = model.transcribe(
            samples,
            language=language,
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = " ".join(s.text.strip() for s in segments).strip()
        if text.lower().strip() in HALLUCINATIONS:
            return ""
        return text

    if args.wav:
        import wave

        with wave.open(args.wav, "rb") as wf:
            raw = wf.readframes(wf.getnframes())
            rate = wf.getframerate()
        pcm = np.frombuffer(raw, dtype="int16").astype("float32") / 32768.0
        if rate != SAMPLE_RATE:
            idx = np.round(np.arange(0, len(pcm), rate / SAMPLE_RATE)).astype(int)
            pcm = pcm[idx[idx < len(pcm)]]
        emit({"type": "ready", "model": args.model, "device": args.wav})
        text = transcribe(pcm)
        if text:
            emit({"type": "text", "text": text})
        emit({"type": "done"})
        return

    audio_q: "queue.Queue" = queue.Queue()

    def callback(indata, _frames, _time, status):
        if status and status.input_overflow:
            pass  # a dropped block is better than a crash
        audio_q.put(indata[:, 0].copy())

    silence_blocks_needed = max(1, args.silence_ms // BLOCK_MS)
    max_segment_blocks = int(args.max_segment_s * 1000 // BLOCK_MS)

    pre_roll: list = []
    segment: list = []
    in_speech = False
    silent_run = 0
    noise_floor = 0.004
    calibrating_blocks = 20  # first 600 ms set the noise floor
    blocks_seen = 0
    stop_requested = False

    def flush():
        nonlocal segment, in_speech, silent_run
        if segment:
            samples = np.concatenate(segment).astype("float32")
            segment = []
            in_speech = False
            silent_run = 0
            text = transcribe(samples)
            if text:
                emit({"type": "text", "text": text})
        else:
            in_speech = False
            silent_run = 0

    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=BLOCK,
            device=device_index,
            callback=callback,
        )
        stream.start()
    except Exception as exc:
        fail(f"could not open microphone {device_name!r}: {exc}")
        return

    emit({"type": "ready", "model": args.model, "device": device_name})

    try:
        while True:
            blocks_seen += 1
            if blocks_seen % STOP_POLL_BLOCKS == 0 and os.path.exists(args.stop_file):
                stop_requested = True
            try:
                block = audio_q.get(timeout=0.5)
            except queue.Empty:
                if stop_requested:
                    break
                continue

            rms = float(np.sqrt(np.mean(block * block)))

            if calibrating_blocks > 0:
                calibrating_blocks -= 1
                noise_floor = 0.8 * noise_floor + 0.2 * rms
                pre_roll.append(block)
                pre_roll = pre_roll[-PRE_ROLL_BLOCKS:]
                if stop_requested:
                    break
                continue

            threshold = max(noise_floor * 3.5, 0.008)
            is_speech = rms > threshold

            if is_speech:
                if not in_speech:
                    in_speech = True
                    segment = list(pre_roll)
                    pre_roll = []
                segment.append(block)
                silent_run = 0
            elif in_speech:
                segment.append(block)
                silent_run += 1
                if silent_run >= silence_blocks_needed:
                    flush()
            else:
                noise_floor = 0.95 * noise_floor + 0.05 * rms
                pre_roll.append(block)
                pre_roll = pre_roll[-PRE_ROLL_BLOCKS:]

            if in_speech and len(segment) >= max_segment_blocks:
                flush()

            if stop_requested:
                break

        # Drain what the callback queued while we were transcribing.
        while True:
            try:
                segment.append(audio_q.get_nowait())
            except queue.Empty:
                break
        if in_speech or (segment and len(segment) > PRE_ROLL_BLOCKS):
            flush()
    finally:
        try:
            stream.stop()
            stream.close()
        except Exception:
            pass
        try:
            if os.path.exists(args.stop_file):
                os.remove(args.stop_file)
        except OSError:
            pass

    emit({"type": "done"})


if __name__ == "__main__":
    main()
