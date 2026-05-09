'use client';

import { useMemo, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';

export type InlineSelectOption = {
  label: string;
  value: string;
};

type InlineSelectProps = {
  name: string;
  value?: string;
  defaultValue: string;
  options: InlineSelectOption[];
  ariaLabel: string;
  className?: string;
  onValueChange?: (value: string) => void;
};

export function InlineSelect({
  name,
  value,
  defaultValue,
  options,
  ariaLabel,
  className,
  onValueChange
}: InlineSelectProps) {
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = value ?? internalValue;
  const selectedOption = useMemo(
    () => options.find((option) => option.value === selectedValue) ?? options[0],
    [options, selectedValue]
  );

  return (
    <>
      <input type="hidden" name={name} value={selectedValue} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={ariaLabel}
            className={cn(
              'group inline-flex min-w-0 cursor-pointer items-center gap-1 rounded-md bg-transparent px-0 py-0 text-sm font-semibold text-foreground outline-none transition hover:text-foreground/85',
              className
            )}
          >
            <span className="truncate">{selectedOption?.label ?? ''}</span>
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground transition group-hover:text-foreground/70" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="min-w-44 rounded-lg border border-border/70 bg-surface-1 p-1 text-foreground shadow-xl"
        >
          {options.map((option) => {
            const isSelected = option.value === selectedValue;

            return (
              <DropdownMenuItem
                key={option.value}
                onSelect={() => {
                  setInternalValue(option.value);
                  onValueChange?.(option.value);
                }}
                className="cursor-pointer rounded-md px-2.5 py-2 text-sm"
              >
                <span className="flex-1">{option.label}</span>
                <Check className={cn('h-4 w-4', isSelected ? 'opacity-100' : 'opacity-0')} />
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
