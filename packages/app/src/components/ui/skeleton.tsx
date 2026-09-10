import { useEffect, useMemo, useRef } from "react";
import { Animated, type StyleProp, type ViewStyle } from "react-native";

/**
 * The app's one skeleton pulse. A skeleton exists to hold a layout box open at
 * the size its real content will take, so use it wherever content arrives late
 * enough that its absence would move something already on screen — never as a
 * decoration on top of a spinner.
 *
 * One `useSkeletonPulse()` per skeleton tree, shared by every `SkeletonPulse`
 * in it: separate Animated.Values start at separate times and the blocks then
 * pulse out of phase, which reads as noise rather than as one loading surface.
 *
 * Pass `active: false` when the skeleton's owner stays mounted after its data
 * lands (a lane, a section header) — the hook can't be called conditionally,
 * and an unconditional loop would keep animating a value nothing renders.
 */
export function useSkeletonPulse(active = true): Animated.Value {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!active) {
      return;
    }
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1000, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1000, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [pulse, active]);
  return pulse;
}

/** One placeholder block. `style` carries its size, radius and background. */
export function SkeletonPulse({
  pulse,
  style,
}: {
  pulse: Animated.Value;
  style: StyleProp<ViewStyle>;
}) {
  const opacity = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [0.4, 0.8],
  });
  const pulseStyle = useMemo(() => [style, { opacity }], [style, opacity]);
  return <Animated.View style={pulseStyle} pointerEvents="none" />;
}
