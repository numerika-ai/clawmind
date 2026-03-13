/**
 * Default topic seeds for Memory Bank
 */

export const DEFAULT_TOPICS: Array<{
  name: string;
  description: string;
  ttl_days: number | null;
  priority: number;
}> = [
  {
    name: "user_preferences",
    description: "User preferences, habits, style",
    ttl_days: null,
    priority: 9,
  },
  {
    name: "technical_facts",
    description: "Configs, architectures, versions",
    ttl_days: 90,
    priority: 8,
  },
  {
    name: "project_context",
    description: "Active project details, goals",
    ttl_days: 30,
    priority: 7,
  },
  {
    name: "instructions",
    description: "Explicit user rules",
    ttl_days: null,
    priority: 10,
  },
  {
    name: "people_orgs",
    description: "People, organizations",
    ttl_days: null,
    priority: 6,
  },
  {
    name: "decisions",
    description: "Key decisions + reasoning",
    ttl_days: 60,
    priority: 7,
  },
  {
    name: "learned_patterns",
    description: "Patterns from interactions",
    ttl_days: 90,
    priority: 5,
  },
];
