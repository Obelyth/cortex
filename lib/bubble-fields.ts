import { z } from "zod";
import { normaliseProject } from "./project";
import { utf8Bytes } from "./utf8";

export const BUBBLE_KINDS = ["focus", "decision", "question", "handoff"] as const;
export const bubbleKind = z.enum(BUBBLE_KINDS);
export const bubbleBody = z.string().min(1).max(2000).refine(s => !s.includes("\0") && utf8Bytes(s) <= 8000);
export const bubbleProject = z.string().max(80).refine(s => !s.includes("\0") && utf8Bytes(s) <= 320).transform(normaliseProject);
