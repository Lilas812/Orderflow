import "./long-vp.css";
import { viewLink } from "./view-math.ts";
import { instrumentSelectHtml } from "../instrument.ts";

export function viewSwitchHtml(active: "heatmap" | "footprint" | "longvp"): string {
  return `${instrumentSelectHtml()}<nav class="view-switch" aria-label="画面の切り替え">
    <a href="${viewLink("heatmap")}" data-testid="link-view-heatmap"${active === "heatmap" ? ' aria-current="page"' : ""}>HEATMAP</a>
    <a href="${viewLink("footprint")}" data-testid="link-view-footprint"${active === "footprint" ? ' aria-current="page"' : ""}>FOOTPRINT</a>
    <a href="${viewLink("longvp")}" data-testid="link-view-longvp"${active === "longvp" ? ' aria-current="page"' : ""}>LONG VP</a>
  </nav>`;
}
