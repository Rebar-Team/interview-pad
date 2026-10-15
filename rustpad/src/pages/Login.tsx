import { Brand } from "@/components/Brand";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { loginUrl } from "@/lib/api";
import { AlertCircle } from "lucide-react";

const AUTH_ERRORS: Record<string, string> = {
  domain: "Use your withrebar.ai Google account.",
  state: "Your sign-in link expired. Try again.",
  exchange: "Google sign-in failed. Try again.",
  config: "Sign-in is not configured on this server.",
};

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1A6.6 6.6 0 0 1 5.5 12c0-.73.13-1.43.34-2.1V7.06H2.18A11 11 0 0 0 1 12c0 1.78.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A10.96 10.96 0 0 0 12 1 11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
      />
    </svg>
  );
}

export default function Login() {
  const code = new URLSearchParams(window.location.search).get("auth_error");
  const error = code
    ? (AUTH_ERRORS[code] ?? "Sign-in failed. Try again.")
    : null;

  return (
    <div className="flex min-h-full flex-col items-center justify-center bg-background px-6 pb-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <Brand className="scale-125" />
        <div className="space-y-1.5">
          <h1 className="text-2xl font-semibold tracking-tight">
            Interviews, in one pad
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in with your Rebar Google account to create interview rooms.
          </p>
        </div>
        {error && (
          <Alert variant="destructive" className="text-left">
            <AlertCircle />
            <AlertTitle>Couldn't sign you in</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button
          size="lg"
          variant="outline"
          className="w-full gap-2"
          onClick={() => (window.location.href = loginUrl("/"))}
        >
          <GoogleMark />
          Sign in with Google
        </Button>
        <p className="text-xs text-muted-foreground">
          Candidates don't need an account. They join with the room link.
        </p>
      </div>
    </div>
  );
}
