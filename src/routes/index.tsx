import { createFileRoute } from "@tanstack/react-router";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import ambientFallback from "../assets/ambient-fallback.mp4";

const title = "Scalable — Manage your sales and analytics in one place";
const description =
  "Track custom events, increase form submissions, optimise conversion rates and optimise your sales flow with Scalable.";
// The download script saves the requested CDN asset here. Prefer the local import
// when available; never block the page on a failed external video request.
const localOriginal = import.meta.glob<string>("../assets/hero-gradient.mp4", {
  eager: true,
  query: "?url",
  import: "default",
});
const originalVideo =
  Object.values(localOriginal)[0] ??
  "https://cdn.sceneai.art/Hero%20Section%20Video/1bcc8fa3-37f6-4c53-8591-0347e4c7f8ac.mp4";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [{ title }, { name: "description", content: description }],
  }),
  component: Home,
});

type Panel =
  | "demo"
  | "about"
  | "blog"
  | "changelog"
  | "pricing"
  | "video"
  | "withdraw"
  | null;
type Period = "Daily" | "Weekly" | "Monthly" | "Yearly";

function Icon({
  name,
  size = 18,
}: {
  name: "chevron" | "arrow" | "close" | "menu" | "settings" | "check" | "play";
  size?: number;
}) {
  const paths = {
    chevron: <path d="m6 9 6 6 6-6" />,
    arrow: (
      <>
        <path d="M5 12h14M13 6l6 6-6 6" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    menu: <path d="M4 7h16M4 12h16M4 17h16" />,
    settings: (
      <>
        <path d="M4 7h7m4 0h5M4 17h3m4 0h9" />
        <circle cx="13" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    play: <path d="m9 5 10 7-10 7Z" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function Modal({
  title: heading,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const previousOverflow = document.body.style.overflow;
    const opener = document.activeElement as HTMLElement | null;
    dialog.showModal();
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = previousOverflow;
      queueMicrotask(() => {
        if (!dialog.open && opener?.isConnected)
          opener.focus({ preventScroll: true });
      });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="modal-title"
    >
      <div className="modal-content">
        <div className="modal-top">
          <span className="eyebrow">
            <span className="mini-diamond" /> SCALABLE
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <Icon name="close" />
          </button>
        </div>
        <h2 id="modal-title">{heading}</h2>
        {children}
      </div>
    </dialog>
  );
}

function DemoForm() {
  const [submitted, setSubmitted] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [size, setSize] = useState("1–10 people");
  function downloadBrief() {
    const brief = new Blob(
      [
        `Scalable — Demo brief\n\nName: ${name}\nWork email: ${email}\nCompany: ${company}\nTeam size: ${size}\n\nInterested in: Sales analytics, conversion tracking, and Zapier integration.\n\nThis brief was created in a preview workspace. No demo request has been sent or scheduled.`,
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(brief);
    const link = document.createElement("a");
    link.href = url;
    link.download = "scalable-demo-brief.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  if (submitted)
    return (
      <div className="demo-success">
        <span className="success-icon">
          <Icon name="check" size={25} />
        </span>
        <h3>Your demo brief is ready, {name.split(" ")[0]}.</h3>
        <p>
          Download your details to share with your team. This is a preview
          workspace; no request has been sent or scheduled.
        </p>
        <button className="button w-full" onClick={downloadBrief}>
          Download demo brief <Icon name="arrow" />
        </button>
        <button className="text-button" onClick={() => setSubmitted(false)}>
          Edit your details
        </button>
      </div>
    );
  return (
    <>
      <p className="modal-intro">
        A clearer view of your business starts here. Tell us a little about your
        team.
      </p>
      <form
        className="form-stack"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(true);
        }}
      >
        <label>
          Your name
          <input
            required
            autoComplete="name"
            placeholder="Alex Morgan"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={100}
          />
        </label>
        <label>
          Work email
          <input
            required
            type="email"
            autoComplete="email"
            placeholder="alex@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            maxLength={200}
          />
        </label>
        <div className="form-columns">
          <label>
            Company
            <input
              required
              autoComplete="organization"
              placeholder="Company name"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              maxLength={100}
            />
          </label>
          <label>
            Team size
            <select value={size} onChange={(e) => setSize(e.target.value)}>
              <option>1–10 people</option>
              <option>11–50 people</option>
              <option>51–200 people</option>
              <option>201+ people</option>
            </select>
          </label>
        </div>
        <button className="button w-full" type="submit">
          Prepare my demo <Icon name="arrow" />
        </button>
        <p className="form-note">
          Interactive preview. Your details stay in this session and aren’t sent
          to a server.
        </p>
      </form>
    </>
  );
}

const chartPaths: Record<Period, string> = {
  Monthly:
    "M0 148 C22 148 29 157 47 147 S75 113 98 117 S129 133 150 111 S171 126 192 105 S216 101 237 106 S260 74 281 79 S307 108 328 97 S349 71 373 74 S399 57 421 64 S451 39 474 44 S502 16 526 26 S562 8 582 12 S594 5 600 6",
  Daily:
    "M0 155 C25 155 29 129 54 139 S83 167 110 145 S141 106 166 121 S196 118 224 96 S252 107 282 85 S310 83 335 99 S364 64 393 76 S422 91 448 64 S484 67 510 43 S540 56 568 31 S589 24 600 21",
  Weekly:
    "M0 166 C28 170 33 145 61 149 S95 122 121 131 S155 155 182 124 S219 109 245 116 S276 76 302 86 S334 61 361 77 S390 79 418 48 S452 54 478 39 S510 54 540 28 S575 34 600 12",
  Yearly:
    "M0 178 C23 184 40 175 65 173 S102 157 128 164 S164 148 188 151 S215 124 244 136 S270 114 297 121 S326 100 353 103 S385 89 411 94 S443 61 469 70 S501 45 529 48 S568 16 600 6",
};
const axisLabels: Record<Period, string[]> = {
  Daily: ["00:00", "04:00", "08:00", "12:00", "16:00", "20:00"],
  Weekly: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"],
  Monthly: ["Jan", "Feb", "Mar", "Apr", "May", "Jun"],
  Yearly: ["2021", "2022", "2023", "2024", "2025", "2026"],
};

function Dashboard({ onWithdraw }: { onWithdraw: () => void }) {
  const [period, setPeriod] = useState<Period>("Monthly");
  const stats = [
    { label: "Total Profit", value: "$9,432.25", delta: "+84%" },
    { label: "Total Revenue", value: "$404,585", delta: "+47%" },
    { label: "Products Sold", value: "1,457", delta: "+24%" },
  ];
  const segments = [
    { label: "Employee", value: 73 },
    { label: "Independent Contractor", value: 49 },
    { label: "Contracted Employee", value: 88 },
    { label: "Stakeholders", value: 61 },
  ];
  return (
    <section
      className="dashboard"
      id="dashboard"
      aria-label="Scalable analytics dashboard preview"
    >
      <div className="stats-grid">
        {stats.map((stat) => (
          <article className="glass-card stat-card" key={stat.label}>
            <div className="stat-heading">
              <h2>{stat.label}</h2>
              <span className="delta">↗ {stat.delta}</span>
            </div>
            <p className="stat-value">{stat.value}</p>
            <span className="stat-footnote">vs. last month</span>
          </article>
        ))}
      </div>
      <div className="details-grid">
        <article className="glass-card balance-card">
          <h2>Total Balance</h2>
          <p className="balance-value">$675,931</p>
          <button className="button withdraw-button" onClick={onWithdraw}>
            Withdraw <Icon name="arrow" size={15} />
          </button>
          <div className="balance-detail">
            <div>
              <span>Total Income</span>
              <strong>$21,478</strong>
            </div>
            <span className="income-percent">
              92% <span>↗</span>
            </span>
          </div>
          <div className="balance-detail expense">
            <div>
              <span>Total Expense</span>
              <strong>$9,627</strong>
            </div>
            <span className="expense-arrow">↘</span>
          </div>
        </article>
        <article className="glass-card chart-card">
          <div className="chart-heading">
            <h2>Revenue Overview</h2>
            <div
              className="chart-tabs"
              role="tablist"
              aria-label="Revenue period"
            >
              {(["Daily", "Weekly", "Monthly", "Yearly"] as Period[]).map(
                (item, index, items) => (
                  <button
                    id={`tab-${item}`}
                    aria-controls="revenue-chart"
                    key={item}
                    role="tab"
                    aria-selected={period === item}
                    tabIndex={period === item ? 0 : -1}
                    className={period === item ? "active" : ""}
                    onClick={() => setPeriod(item)}
                    onKeyDown={(e) => {
                      if (
                        ["ArrowRight", "ArrowLeft", "Home", "End"].includes(
                          e.key,
                        )
                      ) {
                        e.preventDefault();
                        const next =
                          e.key === "Home"
                            ? items[0]
                            : e.key === "End"
                              ? items[3]
                              : items[
                                  (index + (e.key === "ArrowRight" ? 1 : 3)) % 4
                                ];
                        setPeriod(next);
                        document.getElementById(`tab-${next}`)?.focus();
                      }
                    }}
                  >
                    {item}
                  </button>
                ),
              )}
            </div>
          </div>
          <div
            className="chart-body"
            id="revenue-chart"
            role="tabpanel"
            aria-labelledby={`tab-${period}`}
            tabIndex={0}
          >
            <div className="chart-y-axis">
              <span>50k</span>
              <span>40k</span>
              <span>30k</span>
              <span>20k</span>
            </div>
            <div className="chart-plot">
              <svg
                className="revenue-chart"
                viewBox="0 0 600 200"
                preserveAspectRatio="none"
                role="img"
                aria-label={`${period} revenue trend, illustrative sample data rising from about 20 thousand to 50 thousand dollars`}
              >
                <defs>
                  <linearGradient
                    id="revenue-gradient"
                    x1="0"
                    y1="0"
                    x2="1"
                    y2="0"
                  >
                    <stop offset="0%" stopColor="var(--chart-cyan)" />
                    <stop offset="100%" stopColor="var(--chart-blue)" />
                  </linearGradient>
                  <linearGradient
                    id="area-gradient"
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="0%" stopColor="var(--chart-area)" />
                    <stop offset="100%" stopColor="var(--transparent)" />
                  </linearGradient>
                </defs>
                {[20, 70, 120, 170].map((y) => (
                  <line
                    key={y}
                    x1="0"
                    y1={y}
                    x2="600"
                    y2={y}
                    stroke="var(--border-subtle)"
                    strokeDasharray="3 5"
                  />
                ))}
                <path
                  d={`${chartPaths[period]} L600 200 L0 200 Z`}
                  fill="url(#area-gradient)"
                />
                <path
                  d={chartPaths[period]}
                  fill="none"
                  stroke="url(#revenue-gradient)"
                  strokeWidth="2.5"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx="328"
                  cy={
                    period === "Monthly"
                      ? 97
                      : period === "Daily"
                        ? 97
                        : period === "Weekly"
                          ? 74
                          : 106
                  }
                  r="12"
                  fill="var(--chart-halo)"
                />
                <circle
                  cx="328"
                  cy={
                    period === "Monthly"
                      ? 97
                      : period === "Daily"
                        ? 97
                        : period === "Weekly"
                          ? 74
                          : 106
                  }
                  r="4"
                  fill="var(--foreground)"
                />
              </svg>
              <div className="chart-x-axis">
                {axisLabels[period].map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </div>
          </div>
        </article>
        <article className="glass-card audience-card">
          <div className="audience-heading">
            <h2>Your team</h2>
            <span className="tiny-dots" aria-hidden="true">
              •••
            </span>
          </div>
          {segments.map((segment) => (
            <div className="progress-row" key={segment.label}>
              <div className="progress-label">
                <span>{segment.label}</span>
                <span className="progress-value">{segment.value}%</span>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label={segment.label}
                aria-valuenow={segment.value}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="progress-fill"
                  style={{ width: `${segment.value}%` }}
                />
              </div>
            </div>
          ))}
        </article>
      </div>
    </section>
  );
}

function Home() {
  const [panel, setPanel] = useState<Panel>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [videoSource, setVideoSource] = useState(originalVideo);
  const [videoInput, setVideoInput] = useState("");
  const [videoReady, setVideoReady] = useState(false);
  const [videoStatus, setVideoStatus] = useState(
    "Loading the original ambient video…",
  );
  const [videoError, setVideoError] = useState("");
  const [reducedMotion, setReducedMotion] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReducedMotion(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (reducedMotion || videoReady) return;
    const timeout = window.setTimeout(() => {
      if (videoSource !== ambientFallback) {
        setVideoSource(ambientFallback);
        setVideoStatus(
          "The video could not load. Using the local ambient fallback.",
        );
      } else setVideoStatus("Using the static gradient fallback.");
    }, 9000);
    return () => window.clearTimeout(timeout);
  }, [videoSource, videoReady, reducedMotion]);
  useEffect(() => {
    function close(event: MouseEvent) {
      if (!pagesRef.current?.contains(event.target as Node))
        setPagesOpen(false);
    }
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, []);

  function openPanel(next: Panel) {
    setPanel(next);
    setMenuOpen(false);
    setPagesOpen(false);
  }
  function onVideoError() {
    setVideoReady(false);
    if (videoSource !== ambientFallback) {
      setVideoSource(ambientFallback);
      setVideoStatus(
        "The video could not load. Using the local ambient fallback.",
      );
    } else setVideoStatus("Using the static gradient fallback.");
  }
  function applyVideo(event: FormEvent) {
    event.preventDefault();
    try {
      const url = new URL(videoInput);
      if (url.protocol !== "https:" && url.protocol !== "http:")
        throw new Error("invalid");
      setVideoError("");
      setVideoReady(false);
      setVideoSource(url.href);
      setVideoStatus("Loading your video…");
    } catch {
      setVideoError("Enter a valid, direct HTTPS or HTTP video URL.");
    }
  }
  const headings: Record<Exclude<Panel, null>, string> = {
    demo: "Let’s see what’s possible.",
    about: "Less noise. More clarity.",
    blog: "The Scalable field notes.",
    changelog: "Small updates. Bigger possibilities.",
    pricing: "Built for your next chapter.",
    video: "Set the atmosphere.",
    withdraw: "A preview of your bigger picture.",
  };
  const navItems: { label: string; panel: Panel }[] = [
    { label: "About", panel: "about" },
    { label: "Blog", panel: "blog" },
    { label: "Changelog", panel: "changelog" },
    { label: "Pricing", panel: "pricing" },
  ];

  return (
    <div className="site-shell min-h-screen bg-background text-foreground">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="site-header">
        <div className="navbar mx-auto flex items-center justify-between">
          <a className="wordmark" href="#" aria-label="Scalable home">
            <span className="logo-symbol">
              <span />
            </span>
            Scalable
          </a>
          <nav
            className="desktop-nav hidden md:flex"
            aria-label="Main navigation"
          >
            {navItems.map((item) => (
              <button key={item.label} onClick={() => openPanel(item.panel)}>
                {item.label}
                {item.panel === "changelog" && (
                  <span className="new-tag">✦ New</span>
                )}
              </button>
            ))}
            <div
              className="pages-dropdown"
              ref={pagesRef}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setPagesOpen(false);
                  (
                    pagesRef.current?.firstElementChild as HTMLButtonElement
                  )?.focus();
                }
              }}
            >
              <button
                aria-expanded={pagesOpen}
                aria-controls="pages-menu"
                onClick={() => setPagesOpen(!pagesOpen)}
              >
                Pages <Icon name="chevron" size={13} />
              </button>
              {pagesOpen && (
                <div id="pages-menu" className="dropdown-menu">
                  <a href="#dashboard" onClick={() => setPagesOpen(false)}>
                    Analytics overview <Icon name="arrow" size={15} />
                  </a>
                  <button onClick={() => openPanel("changelog")}>
                    Integrations <Icon name="arrow" size={15} />
                  </button>
                  <button onClick={() => openPanel("video")}>
                    Background settings <Icon name="settings" size={15} />
                  </button>
                </div>
              )}
            </div>
          </nav>
          <div className="nav-actions">
            <button
              className="button nav-cta"
              onClick={() => openPanel("demo")}
            >
              Book Your Demo
            </button>
            <button
              className="icon-button mobile-toggle md:hidden"
              aria-label={menuOpen ? "Close navigation" : "Open navigation"}
              aria-expanded={menuOpen}
              aria-controls="mobile-navigation"
              onClick={() => setMenuOpen(!menuOpen)}
            >
              <Icon name={menuOpen ? "close" : "menu"} />
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-navigation"
            className="mobile-nav"
            aria-label="Mobile navigation"
          >
            {navItems.map((item) => (
              <button key={item.label} onClick={() => openPanel(item.panel)}>
                {item.label}
                {item.panel === "changelog" && (
                  <span className="new-tag">✦ New</span>
                )}
              </button>
            ))}
            <a href="#dashboard" onClick={() => setMenuOpen(false)}>
              Analytics overview
            </a>
            <button onClick={() => openPanel("video")}>
              Background settings
            </button>
          </nav>
        )}
      </header>
      <main id="main">
        <section className="hero relative" aria-labelledby="hero-heading">
          <div
            className={`ambient-wrapper ${videoReady && !reducedMotion ? "video-ready" : ""}`}
            aria-hidden="true"
          >
            <div className="ambient-fallback" />
            {!reducedMotion && (
              <video
                ref={videoRef}
                key={videoSource}
                className="ambient-video"
                src={videoSource}
                autoPlay
                loop
                muted
                playsInline
                preload="auto"
                onCanPlay={() => {
                  setVideoReady(true);
                  setVideoStatus(
                    videoSource === ambientFallback
                      ? "Playing the local ambient fallback."
                      : "Your ambient video is playing.",
                  );
                  void videoRef.current?.play().catch(() => {
                    setVideoReady(false);
                    setVideoStatus(
                      "Autoplay is unavailable. Using the static gradient fallback.",
                    );
                  });
                }}
                onError={onVideoError}
              />
            )}
          </div>
          <div className="hero-content relative z-10 mx-auto flex flex-col items-center text-center">
            <button
              className="feature-pill"
              onClick={() => openPanel("changelog")}
            >
              <span className="status-dot" />
              New Feature: Zapier Integration
              <Icon name="chevron" size={13} />
            </button>
            <h1 id="hero-heading">
              Manage your sales and
              <br />
              analytics in <em>one place.</em>
            </h1>
            <p className="hero-description">
              Track custom events, increase form submissions, optimise
              <br className="desktop-break" /> conversion rates and optimise
              your sales flow with Scalable.
            </p>
            <button
              className="button hero-cta"
              onClick={() => openPanel("demo")}
            >
              Book Your Demo
            </button>
            <div className="trusted-by">
              <p>Used by global powerhouses like</p>
              <div
                className="logos-row"
                aria-label="Savannah, Milano, luminous, theo, Amsterdam"
              >
                <span className="logo-savannah">SAVANNAH</span>
                <span className="logo-milano">
                  <span className="milano-mark" aria-hidden="true">
                    M
                  </span>
                  MILANO
                </span>
                <span className="logo-luminous">
                  <svg
                    width="27"
                    height="27"
                    viewBox="0 0 28 28"
                    aria-hidden="true"
                  >
                    <path fill="currentColor" d="m14 1 13 13-13 13L1 14Z" />
                  </svg>
                  luminous
                </span>
                <span className="logo-theo">theo</span>
                <span className="logo-amsterdam">
                  <span className="amsterdam-mark" aria-hidden="true">
                    ◐
                  </span>
                  Amsterdam
                </span>
              </div>
            </div>
          </div>
          <div className="dashboard-wrap relative z-10 mx-auto">
            <Dashboard onWithdraw={() => openPanel("withdraw")} />
          </div>
        </section>
      </main>
      <footer className="page-footer">
        <span>A little clarity. A lot of possibility.</span>
        <button
          className="background-button"
          onClick={() => openPanel("video")}
        >
          <Icon name="settings" size={14} />
          Background settings
        </button>
      </footer>
      {panel && (
        <Modal title={headings[panel]} onClose={() => setPanel(null)}>
          {panel === "demo" && <DemoForm />}
          {panel === "about" && (
            <>
              <p className="modal-intro">
                Your sales tell a story. Scalable helps you see the whole
                picture, all in one place.
              </p>
              <div className="info-list">
                <div>
                  <span>01</span>
                  <section>
                    <h3>Understand every interaction</h3>
                    <p>
                      Bring custom events and form submissions into a single,
                      focused view.
                    </p>
                  </section>
                </div>
                <div>
                  <span>02</span>
                  <section>
                    <h3>Turn insight into action</h3>
                    <p>
                      Follow your conversion rates and discover where your sales
                      flow can improve.
                    </p>
                  </section>
                </div>
                <div>
                  <span>03</span>
                  <section>
                    <h3>Give your team clarity</h3>
                    <p>
                      A shared perspective on revenue, profit, and the metrics
                      that matter.
                    </p>
                  </section>
                </div>
              </div>
              <button
                className="button w-full"
                onClick={() => openPanel("demo")}
              >
                Explore Scalable <Icon name="arrow" />
              </button>
            </>
          )}
          {panel === "blog" && (
            <>
              <p className="modal-intro">
                A short guide to a more intentional analytics setup.
              </p>
              <article className="field-note">
                <span className="eyebrow">ANALYTICS · 3 MIN READ</span>
                <h3>Start with the questions, not the dashboard.</h3>
                <p>
                  Before tracking another event, ask what decision it will help
                  you make. A focused dashboard makes the next step obvious.
                </p>
                <h4>Find the moments that matter.</h4>
                <p>
                  Choose a few meaningful steps in your customer journey: a form
                  submitted, a trial started, or a first purchase. Track these
                  consistently.
                </p>
                <h4>Look for a pattern, not a spike.</h4>
                <p>
                  Compare the same periods and consider the context. Use weekly
                  and monthly views to separate real changes from daily noise.
                </p>
                <h4>Make one change. Learn. Repeat.</h4>
                <p>
                  Pick a point of friction, test an improvement, and measure its
                  effect on your conversions.
                </p>
              </article>
            </>
          )}
          {panel === "changelog" && (
            <>
              <p className="modal-intro">
                A more connected workflow, with less busywork.
              </p>
              <div className="release-card">
                <span className="release-tag">
                  <span className="status-dot" /> NEW IN SCALABLE
                </span>
                <h3>
                  Meet your new connection.
                  <br />
                  Zapier integration.
                </h3>
                <p>
                  Connect the tools you use every day. Build a workflow that
                  brings your sales activity into focus, without the manual
                  handoffs.
                </p>
                <ul>
                  <li>Connect form submissions to your workflow</li>
                  <li>Keep your sales activity in sync</li>
                  <li>Spend less time moving data</li>
                </ul>
              </div>
              <button
                className="button w-full"
                onClick={() => openPanel("demo")}
              >
                See it in a demo <Icon name="arrow" />
              </button>
            </>
          )}
          {panel === "pricing" && (
            <>
              <p className="modal-intro">
                The right fit depends on your team, your event volume, and the
                way you work. Let’s start with those.
              </p>
              <div className="pricing-details">
                <span className="eyebrow">ONE CONNECTED VIEW</span>
                <h3>Clarity that grows with you.</h3>
                {[
                  "Sales and revenue analytics",
                  "Custom event and conversion tracking",
                  "Connected workflows",
                  "A focused view for your team",
                ].map((item) => (
                  <p key={item}>
                    <Icon name="check" size={17} />
                    {item}
                  </p>
                ))}
              </div>
              <p className="form-note pricing-note">
                Pricing isn’t published in this preview. Explore your
                requirements with a personalised demo brief.
              </p>
              <button
                className="button w-full"
                onClick={() => openPanel("demo")}
              >
                Let’s find your fit <Icon name="arrow" />
              </button>
            </>
          )}
          {panel === "withdraw" && (
            <>
              <p className="modal-intro">
                You’re exploring an illustrative dashboard. These balances are
                sample data, so no money can be moved.
              </p>
              <div className="sample-balance">
                <span>Sample total balance</span>
                <strong>$675,931</strong>
                <span className="preview-label">DEMO WORKSPACE</span>
              </div>
              <button
                className="button w-full"
                onClick={() => openPanel("demo")}
              >
                Explore a personalised demo <Icon name="arrow" />
              </button>
            </>
          )}
          {panel === "video" && (
            <>
              <p className="modal-intro">
                Make the background yours. Paste a direct video link; we’ll keep
                the same soft blur, positioning, and atmospheric glow.
              </p>
              <form className="form-stack" onSubmit={applyVideo}>
                <label htmlFor="video-url">
                  Video link
                  <input
                    id="video-url"
                    type="url"
                    value={videoInput}
                    onChange={(e) => {
                      setVideoInput(e.target.value);
                      setVideoError("");
                    }}
                    placeholder="https://example.com/gradient.mp4"
                    required
                    aria-describedby="video-help video-status"
                    aria-invalid={!!videoError}
                  />
                </label>
                <p id="video-help" className="form-note">
                  Use a direct MP4 or WebM URL, not a YouTube page. Settings
                  apply to this session only.
                </p>
                {videoError && (
                  <p className="error-text" role="alert">
                    {videoError}
                  </p>
                )}
                <button className="button w-full" type="submit">
                  <Icon name="play" size={16} />
                  Apply video
                </button>
              </form>
              <p id="video-status" className="video-status" role="status">
                <span className="status-dot" />
                {reducedMotion
                  ? "Reduced motion is enabled. Showing the static gradient."
                  : videoStatus}
              </p>
              <div className="video-options">
                <button
                  className="secondary-button"
                  onClick={() => {
                    setVideoInput("");
                    setVideoReady(false);
                    setVideoSource(originalVideo);
                    setVideoStatus("Loading the original video…");
                    setVideoError("");
                    if (videoSource === originalVideo) videoRef.current?.load();
                  }}
                >
                  Restore original
                </button>
                <button
                  className="secondary-button"
                  onClick={() => {
                    setVideoInput("");
                    setVideoReady(false);
                    setVideoSource(ambientFallback);
                    setVideoStatus("Loading the local fallback…");
                    setVideoError("");
                    if (videoSource === ambientFallback)
                      videoRef.current?.load();
                  }}
                >
                  Use local fallback
                </button>
              </div>
              <p className="form-note">
                If a video is unavailable, the local ambient video takes over. A
                static gradient is always available as a final fallback.
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
