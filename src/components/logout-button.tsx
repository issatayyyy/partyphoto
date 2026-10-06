"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function handleLogout() {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("Logout failed");
      router.replace("/login");
      router.refresh();
    } catch {
      setError("Не удалось выйти. Попробуйте ещё раз.");
      submitting.current = false;
      setPending(false);
    }
  }

  return (
    <div className="logout-control">
      <button className="button button-outline" type="button" onClick={handleLogout} disabled={pending}>
        {pending ? "Выходим…" : "Выйти"}
      </button>
      <span className="logout-feedback" role="status" aria-live="polite">{error}</span>
    </div>
  );
}
