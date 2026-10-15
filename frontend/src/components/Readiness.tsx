import { useEffect, useState } from "react";
import {
  CheckCircle2,
  AlertCircle,
  Loader2,
  Wifi,
  ShieldCheck,
  UserCheck,
  KeyRound,
  RotateCcw,
  Clock,
} from "lucide-react";
import type { SessionUser } from "../lib/api";
import { useResource, previewMode, date, time } from "../lib/platform";
import { useT } from "../lib/i18n";
import { Feedback } from "./ui";

export interface ReadinessData {
  subject: { name: string; code: string };
  durationMinutes: number;
  maxReentries?: number;
  entriesUsed?: number;
  resultsReleased?: boolean;
  startTime: string;
  endTime: string;
  requiresCode: boolean;
  resumable: boolean;
  submitted: boolean;
  ready: boolean;
  serverTime: string;
  sebVerified?: boolean;
  attemptStatus?: string | null;
  examStatus?: string;
}

export function useExamReadiness(
  user: SessionUser,
  id: string | undefined,
  enabled: boolean,
) {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const query = useResource<ReadinessData>(
    user,
    `/api/v1/student/exams/${id}/readiness`,
    enabled && !!id,
    30000,
  );
  return { query, online };
}

type Check = {
  name: string;
  detail: string;
  state: "pass" | "fail" | "wait";
  Icon: typeof Wifi;
};

// Professional pre-flight: every row is a real gate, not decoration.
// Identity, server-verified SEB, connection, enrollment/window, attempt,
// entry code and clock sync must ALL pass before Start enables.
export function ReadinessChecklist({
  query,
  online,
  user,
}: {
  query: ReturnType<typeof useExamReadiness>["query"];
  online: boolean;
  user: SessionUser;
}) {
  const t = useT();
  const data = query.data;
  const skewSec = data
    ? Math.round((Date.now() - new Date(data.serverTime).getTime()) / 1000)
    : 0;
  const clockOk = !!data && Math.abs(skewSec) <= 300;
  const identityDetail = user.name
    ? `${user.name} · ${user.username ?? ""}`.trim()
    : t("Not signed in");
  const checks: Check[] = [
    {
      name: "Signed in identity",
      detail: identityDetail,
      state: user.name ? "pass" : "fail",
      Icon: UserCheck,
    },
    {
      name: "Exam browser",
      detail: !online
        ? "Offline"
        : query.isPending
          ? "Verifying with server…"
          : "Normal browser accepted — no locked browser required",
      state:
        !online || (!data && !query.isPending)
          ? "fail"
          : data?.sebVerified || previewMode
            ? "pass"
            : "wait",
      Icon: ShieldCheck,
    },
    {
      name: "Connection to server",
      detail: !online
        ? "You are offline"
        : query.isPending
          ? "Checking…"
          : data
            ? "Live"
            : "Server unreachable",
      state: online && !!data ? "pass" : online && query.isPending ? "wait" : "fail",
      Icon: Wifi,
    },
    {
      name: "Enrollment & window",
      detail: !data
        ? t("Waiting for server…")
        : data.ready || data.resumable
          ? t("Eligible · window open until {0}", {
              "0": String(time(data.endTime)),
            })
          : data.examStatus !== "approved"
            ? t("Exam not approved yet")
            : t("Outside the availability window"),
      state: !data ? "wait" : data.ready || data.resumable ? "pass" : "fail",
      Icon: Clock,
    },
    {
      name: "Attempt state",
      detail: !data
        ? t("Waiting for server…")
        : data.submitted
          ? t("Already submitted ({0})", {
              "0": data.attemptStatus ?? t("submitted"),
            })
          : data.resumable
            ? t("Resume found ({0}) — timer kept running", {
                "0": data.attemptStatus ?? t("in progress"),
              })
            : t("Fresh attempt — timer starts on Start"),
      state: !data ? "wait" : data.submitted ? "fail" : "pass",
      Icon: RotateCcw,
    },
    {
      name: "Entry code",
      detail: !data
        ? "Waiting for server…"
        : data.requiresCode
          ? "Code required — enter it below"
          : "No code needed",
      state: !data ? "wait" : "pass",
      Icon: KeyRound,
    },
    {
      name: "Clock sync",
      detail: !data
        ? t("Waiting for server…")
        : clockOk
          ? t("In sync ({0}s vs server)", {
              "0": `${skewSec >= 0 ? "+" : ""}${skewSec}`,
            })
          : t("Device clock off by {0}s — fix it or the timer will surprise you", {
              "0": Math.abs(skewSec),
            }),
      state: !data ? "wait" : clockOk ? "pass" : "fail",
      Icon: Clock,
    },
  ];
  const passed = checks.filter((c) => c.state === "pass").length;
  return (
    <div className="readiness-checklist pro" aria-live="polite">
      <p className="subtle readiness-count">
        {t("{0} of {1} checks green", { "0": passed, "1": checks.length })}
      </p>
      {checks.map(({ name, detail, state, Icon }) => (
        <div className={`readiness-row ${state}`} key={name}>
          <Icon size={18} />
          <div>
            <b>{t(name)}</b>
            <span>{t(detail)}</span>
          </div>
          {state === "pass" ? (
            <CheckCircle2 size={17} className="ok" />
          ) : state === "wait" ? (
            <Loader2 size={17} className="spin" />
          ) : (
            <AlertCircle size={17} className="bad" />
          )}
        </div>
      ))}
      {data && (
        <div className="readiness-summary">
          <b>{data.subject.name}</b>
          <p>
            {data.durationMinutes} {t("minutes")} · {date(data.startTime)} ·{" "}
            {time(data.startTime)}–{time(data.endTime)}
          </p>
        </div>
      )}
      <Feedback error={query.error} />
      {query.isError && (
        <button
          type="button"
          className="secondary"
          onClick={() => void query.refetch()}
        >
          {t("Recheck readiness")}
        </button>
      )}
    </div>
  );
}
