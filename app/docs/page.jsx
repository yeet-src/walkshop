/* The docs, typeset: the same text an agent gets from GET /api. */
import Markdown from "@/lib/Markdown.jsx";
import { DOCS } from "@/lib/gql/schema.js";

export default function Docs() {
  return <Markdown text={DOCS} />;
}
