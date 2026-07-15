import type { ComponentProps } from "react";

type BrandLogoVariant = "lockup" | "mark";

type BrandLogoProps = Omit<ComponentProps<"svg">, "children"> & {
  variant?: BrandLogoVariant;
  label?: string;
};

const VIEW_BOXES: Record<BrandLogoVariant, string> = {
  lockup: "165 227 938 768",
  mark: "285 217 667 596",
};

/**
 * Displays the supplied Global Party artwork without modifying its pixels.
 * SVG view boxes only remove the transparent canvas around the full lockup or
 * the GP monogram, keeping one cached source image for every brand surface.
 */
export function BrandLogo({ variant = "lockup", label, className, ...props }: BrandLogoProps) {
  return (
    <svg
      viewBox={VIEW_BOXES[variant]}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      {...props}
    >
      <image
        href="/brand/global-party-logo.png"
        x="0"
        y="0"
        width="1254"
        height="1254"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  );
}
