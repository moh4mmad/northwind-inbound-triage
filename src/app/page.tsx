const previewMessages = [
  {
    sender: "Dana Whitfield",
    subject: "Need updated statement by Friday",
    channel: "Web form",
    category: "Existing client",
    priority: "High",
    summary: "Client needs a portfolio statement for a lender by Friday.",
  },
  {
    sender: "Gregory Palmer",
    subject: "Wealth planning after a liquidity event",
    channel: "Email",
    category: "Prospect",
    priority: "Medium",
    summary: "Prospect seeks tax-efficient planning after an $8M business sale.",
  },
  {
    sender: "Unknown sender",
    subject: "No subject",
    channel: "Web form",
    category: "Needs review",
    priority: "—",
    summary: "This message does not contain enough usable information.",
  },
];

export default function HomePage() {
  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Northwind Advisors</p>
          <h1>Inbound triage</h1>
          <p className="subtitle">Review, prioritize, and route every message with confidence.</p>
        </div>
        <div className="header-actions">
          <span className="provider-pill"><span aria-hidden="true" />Claude · Sonnet 5</span>
          <button type="button" className="primary-button">Analyze all</button>
        </div>
      </header>

      <section className="queue-summary" aria-label="Queue overview">
        <div><strong>13</strong><span>Messages</span></div>
        <div><strong>2</strong><span>High priority</span></div>
        <div><strong>2</strong><span>Need review</span></div>
        <div className="progress-copy"><span>Queue progress</span><strong>8 of 13</strong></div>
      </section>

      <nav className="filters" aria-label="Filter messages">
        <button type="button" className="filter-active">All <span>13</span></button>
        <button type="button">Untriaged <span>5</span></button>
        <button type="button">High <span>2</span></button>
        <button type="button">Needs review <span>2</span></button>
        <button type="button">Failed <span>0</span></button>
      </nav>

      <section className="message-list" aria-label="Inbound messages">
        {previewMessages.map((message, index) => (
          <article className="message-card" key={message.subject}>
            <div className={`avatar avatar-${index + 1}`} aria-hidden="true">
              {message.sender.slice(0, 1)}
            </div>
            <div className="message-content">
              <div className="message-meta">
                <strong>{message.sender}</strong>
                <span>{message.channel}</span>
                <time>Jul 20 · {index === 0 ? "10:02 AM" : index === 1 ? "9:14 AM" : "4:29 PM"}</time>
              </div>
              <h2>{message.subject}</h2>
              <p>{message.summary}</p>
            </div>
            <div className="triage-result">
              <div className="badges">
                <span className={message.category === "Needs review" ? "badge review" : "badge"}>{message.category}</span>
                <span className={`priority priority-${message.priority.toLowerCase()}`}>{message.priority}</span>
              </div>
              <button type="button" className="secondary-button">View details</button>
            </div>
          </article>
        ))}
      </section>
    </main>
  );
}
