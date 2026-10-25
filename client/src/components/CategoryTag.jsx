import { Tip } from './HelpDot.jsx';
import { topicNumber } from '../lib/categoryAbbr.js';

// A reporting category as its short label (P, CRC: lib/categoryAbbr.js), never its number or its
// long title in a tight space (#196); the full name on hover, focus or tap. `label` is one entry of
// categoryLabels(): { abbr, name }.
export default function CategoryTag({ label }) {
  if (!label) return null;
  return <Tip className="category-tag" text={label.name}>{label.abbr}</Tip>;
}

// The small line under a topic's title: its category's short label and its number ("CTP 2.3").
// `labels` is categoryLabels() over the view's topics. A category Prism has no label for shows its
// title as it is.
export function TopicSource({ topic, labels }) {
  const label = labels.get(topic.category_title);
  const number = topic.external_id ? topicNumber(topic.external_id) : '';
  return (
    <>
      {label ? <CategoryTag label={label} /> : topic.category_title}
      {(label || topic.category_title) && number ? ' ' : ''}
      {number}
    </>
  );
}
