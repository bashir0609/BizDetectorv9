export function normalizePeople(people) {
  return (people || [])
    .map((person) => {
      if (!person || typeof person !== "object") {
        return null;
      }
      const linkedinValue = person.linkedinUrl || person.linkedin || person.linkedIn || person.profileUrl || "";
      const normalized = {
        name: String(person.name || "").trim(),
        title: String(person.title || person.role || "").trim(),
        department: String(person.department || "").trim(),
        email: String(person.email || "").trim(),
        phone: String(person.phone || "").trim(),
        linkedinUrl: String(linkedinValue || "").trim(),
        linkedin: String(linkedinValue || "").trim(),
        bio: String(person.bio || person.summary || person.description || "").trim(),
        confidence: String(person.confidence || "").trim(),
        sourceUrl: String(person.sourceUrl || person.url || "").trim(),
        sourceTitle: String(person.sourceTitle || "").trim()
      };
      return normalized.name ? normalized : null;
    })
    .filter(Boolean);
}

function mergePerson(existing, incoming) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (!merged[key] && value) merged[key] = value;
  }
  return merged;
}

export function dedupePeople(people) {
  const map = new Map();
  for (const person of normalizePeople(people)) {
    const key = `${person.name.toLowerCase()}|${person.title.toLowerCase()}`;
    if (!map.has(key)) {
      map.set(key, person);
    } else {
      map.set(key, mergePerson(map.get(key), person));
    }
  }
  return [...map.values()];
}
