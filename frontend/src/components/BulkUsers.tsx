import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { SessionUser } from "../lib/api";
import { request, invalidateResources, type Entity } from "../lib/platform";
import { useT } from "../lib/i18n";
import { Dialog, Feedback } from "./ui";
export function BulkUsers({
  user,
  rows,
  selected,
  clear,
}: {
  user: SessionUser;
  rows: Entity[];
  selected: string[];
  clear: (succeededIds?: string[]) => void;
}) {
  const t = useT();
  const [operation, setOperation] = useState<boolean | null>(null);
  const [report, setReport] = useState<
    { id: string; ok: boolean; name: string; error?: string }[]
  >([]);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );
  const mutation = useMutation({
    mutationFn: async (active: boolean) => {
      const controller = new AbortController();
      abortRef.current = controller;
      const ids = [...selected];
      const outcomes: typeof report = [];
      // Sequential chunks of 5 (concurrency 5) with abort support.
      for (let i = 0; i < ids.length; i += 5) {
        if (controller.signal.aborted) break;
        const chunk = ids.slice(i, i + 5);
        const results = await Promise.all(
          chunk.map(async (id) => {
            const name = String(rows.find((r) => r.id === id)?.name ?? id);
            try {
              await request(
                `/api/v1/admin/users/${encodeURIComponent(id)}`,
                "PATCH",
                { isActive: active },
                undefined,
                controller.signal,
              );
              return { id, name, ok: true as const };
            } catch (e) {
              return {
                id,
                name,
                ok: false as const,
                error: e instanceof Error ? e.message : String(e),
              };
            }
          }),
        );
        outcomes.push(...results);
        setReport([...outcomes]);
      }
      await invalidateResources(user.id, ["/api/v1/admin/users"]);
      return outcomes;
    },
    onSuccess: (outcomes) => {
      const failed = outcomes.filter((o) => !o.ok);
      if (failed.length === 0) {
        clear();
      } else {
        // Keep failed ids selected; drop only fully successful ones.
        clear(outcomes.filter((o) => o.ok).map((o) => o.id));
      }
      setOperation(null);
    },
  });
  return (
    <>
      <div className="bulk-toolbar">
        <span>
          {selected.length} {t("selected on this page")}
        </span>
        <button
          className="secondary"
          disabled={!selected.length || mutation.isPending}
          onClick={() => {
            setReport([]);
            mutation.reset();
            setOperation(true);
          }}
        >
          {t("Activate selected")}
        </button>
        <button
          className="secondary"
          disabled={!selected.length || mutation.isPending}
          onClick={() => {
            setReport([]);
            mutation.reset();
            setOperation(false);
          }}
        >
          {t("Deactivate selected")}
        </button>
        <button
          className="text-button"
          disabled={!selected.length || mutation.isPending}
          onClick={() => clear()}
        >
          {t("Clear selection")}
        </button>
      </div>
      {report.length > 0 && operation === null && (
        <div className="bulk-report" role="status">
          <p>
            {t("Updated {0} accounts. {1} failed.", {
              "0": report.filter((r) => r.ok).length,
              "1": report.filter((r) => !r.ok).length,
            })}
          </p>
          {report
            .filter((r) => !r.ok)
            .map((r) => (
              <p key={r.id}>
                <bdi>{r.name}</bdi>: {t(r.error ?? "Update failed")}
              </p>
            ))}
        </div>
      )}
      {operation !== null && (
        <Dialog
          title={t(
            operation
              ? "Activate selected accounts?"
              : "Deactivate selected accounts?",
          )}
          onClose={() => {
            if (!mutation.isPending) setOperation(null);
          }}
        >
          <p className="dialog-copy">
            {t(
              operation
                ? "Activate {0} selected accounts? Existing permissions and enrollments will stay the same."
                : "Deactivate {0} selected accounts? This revokes their sessions immediately. You can reactivate them later.",
              { "0": selected.length },
            )}
          </p>
          <ul className="bulk-account-list">
            {rows
              .filter((r) => selected.includes(r.id))
              .map((r) => (
                <li key={r.id}>
                  <bdi>{String(r.name ?? r.username)}</bdi> ·{" "}
                  <bdi>{r.username}</bdi>
                </li>
              ))}
          </ul>
          <p className="subtle">
            {t(
              "Each account is updated separately. Any failures will be reported. Administrator accounts cannot be selected.",
            )}
          </p>
          <Feedback error={mutation.error} />
          <div role="status" className="subtle">
            {mutation.isPending &&
              t("Processed {0} of {1}", {
                "0": report.length,
                "1": selected.length,
              })}
          </div>
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={mutation.isPending}
              onClick={() => setOperation(null)}
            >
              {t("Cancel")}
            </button>
            <button
              className={operation ? "primary" : "danger"}
              disabled={mutation.isPending}
              onClick={() => mutation.mutate(operation)}
            >
              {t(mutation.isPending ? "Working…" : "Confirm")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
