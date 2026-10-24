import { createRoot } from "react-dom/client";
import App from "../../web/src/App";
import "../../web/src/styles.css";
import { desktopSettings } from "./services";

const root = createRoot(document.getElementById("root")!);
root.render(<App initialMock settingsTransport={desktopSettings} />);
let disposed = false;
const dispose = () => {
  if (disposed) return;
  disposed = true;
  root.unmount();
};
window.addEventListener("pagehide", dispose, { once: true });
window.addEventListener("beforeunload", dispose, { once: true });
