import { integerUs, type Config } from "./model.ts";
export interface Interval { sample_id: string; as_of_us: string; feature_start_us: string; target_end_us: string; }
export function assignSplits(samples: Interval[], config: Config["splits"]) {
  return samples.map(s => {
    if (!config?.length) return { sample_id: s.sample_id, fold: null, status: "unconfigured", reason: "split_unset_evaluation_not_possible" };
    const t = integerUs(s.as_of_us), end = integerUs(s.target_end_us);
    const folds = config.filter(f => t >= integerUs(f.fromUs) && t < integerUs(f.toUs));
    if (folds.length !== 1) return { sample_id: s.sample_id, fold: null, status: "excluded",
      reason: folds.length ? "same_market_sample_across_folds" : "outside_configured_folds" };
    const f = folds[0]!;
    if (f.fold === "train" && config.some(v => v.fold !== "train" && t < integerUs(v.toUs) && end > integerUs(v.fromUs)))
      return { sample_id: s.sample_id, fold: f.fold, status: "excluded", reason: "train_target_overlaps_evaluation_judgment_interval" };
    return { sample_id: s.sample_id, fold: f.fold, status: "assigned", reason: null };
  });
}
