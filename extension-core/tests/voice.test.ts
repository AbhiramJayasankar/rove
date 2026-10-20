import { describe, expect, it, vi } from "vitest";
import { DEFAULT_VOICE, MAX_AUDIO_BYTES, microphoneError, transcriptionUrl, transcribe } from "../../src/voice";

const audio = new Blob(["audio bytes"], { type: "audio/webm" });
describe("voice transcription", () => {
  it("sends an authenticated multipart WebM clip only to the configured endpoint", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ text: "  find red pandas  " }));
    expect(await transcribe(audio, { ...DEFAULT_VOICE, baseUrl: "https://speech.example/v1/", model: "custom-whisper" }, "voice-secret", 3, undefined, request)).toBe("find red pandas");
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://speech.example/v1/audio/transcriptions");
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer voice-secret" }, redirect: "error", credentials: "omit" });
    expect(Object.keys(init!.headers!)).toEqual(["Authorization"]);
    const body = init!.body as FormData;
    expect(body.get("model")).toBe("custom-whisper");
    expect(body.get("response_format")).toBe("json");
    const file = body.get("file") as File;
    expect(file.name).toBe("dictation.webm"); expect(file.type).toBe("audio/webm"); expect(await file.text()).toBe("audio bytes");
  });
  it.each([[401, "key was rejected"], [403, "key was rejected"], [429, "rate limit"], [413, "too large"], [408, "timed out"], [504, "timed out"], [400, "HTTP 400"], [500, "HTTP 500"]])("maps HTTP %s without exposing provider payloads", async (status, message) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("private provider payload", { status: status as number }));
    await expect(transcribe(audio, DEFAULT_VOICE, "key", 1, undefined, request)).rejects.toThrow(message as string);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{}, { text: " " }, { text: 7 }])("rejects empty or malformed transcripts", async data => {
    await expect(transcribe(audio, DEFAULT_VOICE, "key", 1, undefined, vi.fn().mockResolvedValue(Response.json(data)))).rejects.toThrow("No speech");
  });
  it("maps network, timeout and cancellation errors without retrying", async () => {
    for (const [error, message] of [[new TypeError("fetch failed"), "Could not reach"], [new DOMException("", "TimeoutError"), "timed out"]] as const) {
      const request = vi.fn<typeof fetch>().mockRejectedValue(error);
      await expect(transcribe(audio, DEFAULT_VOICE, "key", 1, undefined, request)).rejects.toThrow(message);
      expect(request).toHaveBeenCalledTimes(1);
    }
    const controller = new AbortController(); controller.abort();
    await expect(transcribe(audio, DEFAULT_VOICE, "key", 1, controller.signal, vi.fn().mockRejectedValue(new Error()))).rejects.toThrow("cancelled");
  });
  it("rejects invalid credentials, oversized/empty clips and long OpenRouter clips before dispatch", async () => {
    const request = vi.fn<typeof fetch>();
    await expect(transcribe(audio, DEFAULT_VOICE, "", 1, undefined, request)).rejects.toThrow("API key");
    await expect(transcribe(new Blob(), DEFAULT_VOICE, "key", 1, undefined, request)).rejects.toThrow("No audio");
    await expect(transcribe(new Blob([new Uint8Array(MAX_AUDIO_BYTES)]), DEFAULT_VOICE, "key", 1, undefined, request)).rejects.toThrow("25 MB");
    await expect(transcribe(audio, { ...DEFAULT_VOICE, baseUrl: "https://openrouter.ai/api/v1" }, "key", 60, undefined, request)).rejects.toThrow("under 60 seconds");
    expect(request).not.toHaveBeenCalled();
  });
  it("requires secure endpoints and no embedded credentials", () => {
    expect(() => transcriptionUrl("http://example.com/v1")).toThrow("HTTPS");
    expect(() => transcriptionUrl("https://user:pass@example.com/v1")).toThrow("credentials");
    expect(() => transcriptionUrl("https://example.com/v1?key=secret")).toThrow("query");
    expect(transcriptionUrl("http://127.0.0.1:9000/v1").pathname).toBe("/v1/audio/transcriptions");
  });
  it("explains permission, missing microphone and device-busy errors", () => {
    expect(microphoneError(new DOMException("", "NotAllowedError"))).toContain("permission denied");
    expect(microphoneError(new DOMException("", "NotFoundError"))).toContain("No microphone");
    expect(microphoneError(new DOMException("", "NotReadableError"))).toContain("another app");
  });
});
