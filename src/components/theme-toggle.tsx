"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

const noopSubscribe = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();

  // El tema real solo se conoce en el cliente. useSyncExternalStore devuelve false
  // durante el renderizado en servidor y true tras hidratar, así que se reserva el
  // hueco del icono sin desajustes de hidratación y sin setState dentro de un efecto.
  const mounted = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false
  );

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={resolvedTheme === "dark" ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="size-10 rounded-full text-muted-foreground hover:text-foreground"
    >
      {mounted ? (
        resolvedTheme === "dark" ? (
          <Sun className="size-[18px]" />
        ) : (
          <Moon className="size-[18px]" />
        )
      ) : (
        <span className="size-[18px]" />
      )}
    </Button>
  );
}
