import { useRouteSeo } from "./common";
import { seo } from "./strings";
import { PRIVACY_LAST_UPDATED, PrivacyBody, PrivacyIntro } from "./privacy-content";
import "./pages.css";

export default function Privacy() {
  useRouteSeo(seo.privacy);
  return (
    <main id="main" className="app-main rc-page rc-legal">
      <div className="container rc-narrow">
        <header className="rc-legal-head">
          <div className="eyebrow">Legal</div>
          <h1>Privacy Policy</h1>
          <p className="mono muted">Last updated: {PRIVACY_LAST_UPDATED}</p>
          <PrivacyIntro />
        </header>
        <PrivacyBody />
      </div>
    </main>
  );
}
