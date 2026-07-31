export type Greeting = 'Good morning' | 'Good afternoon' | 'Good evening'

/**
 * Time-of-day salutation for the home masthead, from the user's local clock.
 *
 * Three buckets, not four: "Good night" is a farewell, not a greeting, so the small hours fold
 * into evening (18:00–04:59) rather than getting their own line.
 */
export function greetingFor(d: Date): Greeting {
  const h = d.getHours()
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 18) return 'Good afternoon'
  return 'Good evening'
}
