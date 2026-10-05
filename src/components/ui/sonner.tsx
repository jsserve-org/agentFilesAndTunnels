import { Toaster as Sonner, type ToasterProps } from "sonner";

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="light"
      className="toaster group"
      style={{ zIndex: 100 }}
      toastOptions={{
        classNames: {
          toast: "font-sans",
          description: "text-muted-foreground",
        },
      }}
      {...props}
    />
  );
}
