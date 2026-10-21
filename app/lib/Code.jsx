"use client";

/* The code view as an island, for pages the isolate renders (the docs,
 * the home page): props are the language and the text. */
import CodeView from "./CodeView.jsx";

export default function Code(props) {
  return <CodeView lang={props.lang} text={props.text} wrap={props.wrap} />;
}
