import { createHash } from "node:crypto";

export const RUN_ID = /^run_[a-f0-9]{64}$/;
export const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;
type Data = Record<string, unknown>;

export function digest(domain: string, bytes: string | Uint8Array): string {
  return `sha256:${createHash("sha256").update(`${domain}\0`).update(bytes).digest("hex")}`;
}
export function validId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}
export function requireValue(ok: unknown): asserts ok {
  if (!ok) throw new Error("Invalid recorded schema.");
}
export function object(value: unknown): asserts value is Data {
  requireValue(value !== null && typeof value === "object" && !Array.isArray(value));
}
export function keys(value: unknown, fields: string): asserts value is Data {
  object(value);
  const expected = fields.split(",");
  const actual = Object.keys(value);
  requireValue(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
  );
}
export function oneOf(value: unknown, choices: string): void {
  requireValue(typeof value === "string" && choices.split(",").includes(value));
}
export function pattern(value: unknown, regex: RegExp): void {
  requireValue(typeof value === "string" && regex.test(value));
}
export function timestamp(value: unknown): void {
  requireValue(typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value));
  requireValue(new Date(value).toISOString() === value);
}
