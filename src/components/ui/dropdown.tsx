import * as Dropdown from '@radix-ui/react-dropdown-menu';
import * as React from 'react';
import { cn } from '@/lib/utils';

export const DropdownMenu = Dropdown.Root;
export const DropdownMenuTrigger = Dropdown.Trigger;

export function DropdownMenuContent({ className, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.Content>) {
  return (
    <Dropdown.Portal>
      <Dropdown.Content sideOffset={6} className={cn('z-50 min-w-56 rounded-md border bg-popover p-1 text-popover-foreground shadow-lg', className)} {...props} />
    </Dropdown.Portal>
  );
}

export function DropdownMenuItem({ className, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.Item>) {
  return (
    <Dropdown.Item
      className={cn(
        'relative flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-accent [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof Dropdown.Label>) {
  return <Dropdown.Label className={cn('px-2 py-1.5 text-xs font-semibold text-muted-foreground', className)} {...props} />;
}

export function DropdownMenuSeparator() {
  return <Dropdown.Separator className="-mx-1 my-1 h-px bg-border" />;
}
