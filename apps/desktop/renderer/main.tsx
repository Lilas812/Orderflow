import { createRoot } from "react-dom/client";
import { DesktopHost } from "./DesktopHost";
import "../../web/src/styles.css";

const root = createRoot(document.getElementById("root")!);
root.render(<DesktopHost />);
let disposed = false;
const dispose = () => {
  if (disposed) return;
  disposed = true;
  root.unmount();
};
window.addEventListener("pagehide", dispose, { once: true });
window.addEventListener("beforeunload", dispose, { once: true });
