import "./bootstrap";
import "./storageFallback";
import React from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import App from "./App";
import { AuthGate } from "./components/auth/AuthGate";
import { installUserStorage } from "./services/storage/userStorage";

// Before anything touches storage: every app key becomes namespaced per signed-
// in account, so two users can never read or write each other's books.
installUserStorage();

// Shows a readable error instead of a blank page if rendering ever fails.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("App crashed:", error, info.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20, marginBottom: 8 }}>Something went wrong</h1>
        <pre style={{ whiteSpace: "pre-wrap", color: "#b91c1c" }}>{String(this.state.error.message)}</pre>
        <button onClick={() => window.location.reload()} style={{ marginTop: 12, padding: "6px 12px" }}>
          Reload
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <AuthGate>
      <App />
    </AuthGate>
  </ErrorBoundary>
);
