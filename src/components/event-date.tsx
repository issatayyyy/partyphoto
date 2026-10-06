"use client";
import { useEffect, useState } from "react";

export function EventDate({ value }: { value: string }) {
  const [label, setLabel] = useState(() => new Date(value).toLocaleString("ru-RU", { timeZone: "UTC" }) + " UTC");
  useEffect(() => {
    setLabel(new Date(value).toLocaleString("ru-RU", { dateStyle: "medium", timeStyle: "short" }));
  }, [value]);
  return <time dateTime={value}>{label}</time>;
}
