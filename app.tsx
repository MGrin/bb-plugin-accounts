// bb-plugin-accounts frontend — homepage usage tiles per Claude account.
import { useEffect, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { SubscriptionsSection } from "./app/subscriptions.tsx";
import { UsagePanel } from "./app/panel.tsx";
// One Meter and one set of thresholds for both surfaces — the tiles here and
// the big page. Two copies drift, and a meter that disagrees with the page it
// links to is worse than no meter.
import type { Status } from "./app/current.tsx";
import { capacityNotice, creditLabel, formatPct } from "./app/format.ts";
import { Meter, Notice } from "./app/ui.tsx";

type ForecastLine = {
  confidence: "provisional" | "fitted" | "stale";
  blackout: { earliest: number | null; likely: number | null; latest: number | null; endsAt: number | null };
} | null;

const hhmm = (ts: number | null) =>
  ts === null ? "?" : new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });


export default definePluginApp((app) => {
  // ONE tile for every subscription (MX-1226). Two tiles in two layouts, with no Jev at
  // all, is what mgrin was looking at when he said the page was not unified and data was
  // missing.
  app.slots.homepageSection({ id: "subscriptions", title: "Subscriptions", component: () => <SubscriptionsSection compact /> });
  app.slots.navPanel({
    id: "usage",
    title: "Subscription usage",
    icon: "ChartBar",
    path: "usage",
    component: UsagePanel,
  });
});
