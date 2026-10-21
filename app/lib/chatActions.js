"use server";

/* The chat island's hop into the isolate. */

import { clearChat, history, info, pin, pins, send, setAuto, status, unpin } from "./chat/agent.js";
import { liveBlocks, stopBlock } from "./chat/run.js";

export async function chatSend(text) {
  return send(String(text ?? ""));
}
export async function chatHistory() {
  return history();
}
export async function chatClear() {
  return clearChat();
}
export async function chatStop(id) {
  return { ok: stopBlock(String(id ?? "")) };
}
export async function chatBlocks() {
  return liveBlocks();
}
export async function chatInfo() {
  return info();
}
export async function chatStatus() {
  return status();
}
export async function chatAuto(on) {
  return setAuto(Boolean(on));
}
export async function chatPins() {
  return pins();
}
export async function chatPin(id, span) {
  return pin(String(id ?? ""), { span });
}
export async function chatUnpin(id) {
  return unpin(String(id ?? ""));
}
