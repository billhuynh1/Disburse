'use client';

import { useState, useEffect } from 'react';
import { Copy, Check } from 'lucide-react';

export function Terminal() {
  const [terminalStep, setTerminalStep] = useState(0);
  const [copied, setCopied] = useState(false);
  const terminalSteps = [
    'project: "Episode 42 Launch"',
    'source_asset: youtube_url added',
    'transcript: ready',
    'content_pack: generating',
    'outputs: LinkedIn + X + newsletter',
    'cta_variants: ready',
  ];

  useEffect(() => {
    const timer = setTimeout(() => {
      setTerminalStep((prev) =>
        prev < terminalSteps.length - 1 ? prev + 1 : prev
      );
    }, 500);

    return () => clearTimeout(timer);
  }, [terminalStep]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(terminalSteps.join('\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative w-full overflow-hidden rounded-2xl border border-border/80 bg-[linear-gradient(180deg,hsl(var(--surface-1)),hsl(var(--shell)))] font-mono text-sm text-foreground shadow-[0_22px_60px_rgba(7,9,24,0.5)]">
      <div className="p-4">
        <div className="flex justify-between items-center mb-4">
          <div className="flex space-x-2">
            <div className="h-3 w-3 rounded-full bg-primary/85"></div>
            <div className="h-3 w-3 rounded-full bg-secondary/85"></div>
            <div className="h-3 w-3 rounded-full bg-foreground/45"></div>
          </div>
          <button
            onClick={copyToClipboard}
            className="text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Copy to clipboard"
          >
            {copied ? (
              <Check className="h-5 w-5" />
            ) : (
              <Copy className="h-5 w-5" />
            )}
          </button>
        </div>
        <div className="space-y-2">
          {terminalSteps.map((step, index) => (
            <div
              key={index}
              className={`${index > terminalStep ? 'opacity-0' : 'opacity-100'} transition-opacity duration-300`}
            >
              <span className="text-secondary">$</span> {step}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
