import { EventEmitter } from "node:events";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";

export interface ExamEventData {
  id: string;
  examId: string;
  seq: number;
  type: string;
  payload: unknown;
  createdAt: Date;
}

// Event bus: in-process EventEmitter for single-server dev, Redis pub/sub
// fan-out when REDIS_URL is set (multi-server: broadcasts must reach students
// connected to a different container). Local subscribers always fire; the
// Redis bridge only adds cross-instance delivery.
const examEventBus = new EventEmitter();
examEventBus.setMaxListeners(10_000);

const subscribedChannels = new Set<string>();
let subClient: { subscribe(c: string): Promise<unknown>; on(e: string, l: (...a: never[]) => void): unknown } | null = null;

async function ensureRedisSub(channel: string): Promise<void> {
  const r = await redis();
  if (!r) return;
  if (subscribedChannels.has(channel)) return;
  subscribedChannels.add(channel);
  try {
    if (!subClient) {
      const dup = (r as unknown as { duplicate(): NonNullable<typeof subClient> }).duplicate();
      subClient = dup;
      (subClient as unknown as { on(e: string, l: (ch: string, msg: string) => void): void }).on("message", (ch: string, msg: string) => {
        if (!ch.startsWith("exam:")) return;
        try {
          const ev = JSON.parse(msg) as ExamEventData;
          examEventBus.emit(ch, ev);
        } catch {
          // corrupt publish ignored
        }
      });
    }
    const sub = subClient;
    if (sub) await sub.subscribe(channel);
  } catch {
    subscribedChannels.delete(channel);
  }
}

export async function emitExamEvent(
  examId: string,
  type: string,
  payload: unknown,
): Promise<ExamEventData> {
  const ev = await prisma.examEvent.create({
    data: {
      examId,
      type,
      payload: (payload ?? {}) as never,
    },
  });

  const eventData: ExamEventData = {
    id: ev.id,
    examId: ev.examId,
    seq: ev.seq,
    type: ev.type,
    payload: ev.payload,
    createdAt: ev.createdAt,
  };

  examEventBus.emit(`exam:${examId}`, eventData);
  try {
    const r = await redis();
    if (r) await r.publish(`exam:${examId}`, JSON.stringify(eventData));
  } catch {
    // local emit already delivered; redis is best-effort fan-out
  }
  return eventData;
}

export function broadcastExamEvent(ev: ExamEventData): void {
  examEventBus.emit(`exam:${ev.examId}`, ev);
  void (async () => {
    try {
      const r = await redis();
      if (r) await r.publish(`exam:${ev.examId}`, JSON.stringify(ev));
    } catch {
      // ignore
    }
  })();
}

export function subscribeExamEvents(
  examId: string,
  listener: (ev: ExamEventData) => void,
): void {
  examEventBus.on(`exam:${examId}`, listener);
  void ensureRedisSub(`exam:${examId}`);
}

export function unsubscribeExamEvents(
  examId: string,
  listener: (ev: ExamEventData) => void,
): void {
  examEventBus.off(`exam:${examId}`, listener);
}
