"use client";

import { useState, useSyncExternalStore } from "react";
import { UserRound } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { getUploaderName, setUploaderName } from "@/lib/uploader-name";

const noopSubscribe = () => () => {};

/**
 * Nombre con el que se etiquetan los ficheros que subes.
 *
 * Cuando varias personas comparten el mismo servicio, sin esto la lista es un montón
 * de ficheros sin dueño. Se guarda en el navegador, así que se escribe una vez.
 */
export function UploaderNameField() {
  // El valor vive en localStorage, que no existe al renderizar en el servidor: se
  // lee tras hidratar, sin setState dentro de un efecto.
  const stored = useSyncExternalStore(
    noopSubscribe,
    () => getUploaderName(),
    () => ""
  );
  const [edited, setEdited] = useState<string | null>(null);
  const name = edited ?? stored;

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="uploader" className="flex items-center gap-1.5 text-muted-foreground">
        <UserRound className="size-3.5" aria-hidden />
        <span className="sr-only sm:not-sr-only">Subo como</span>
      </Label>
      <Input
        id="uploader"
        value={name}
        onChange={(e) => {
          setEdited(e.target.value);
          setUploaderName(e.target.value);
        }}
        placeholder="tu nombre"
        maxLength={40}
        autoComplete="nickname"
        className="h-9 w-32 text-sm sm:w-40"
      />
    </div>
  );
}
