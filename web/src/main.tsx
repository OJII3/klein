import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, createTheme } from "@mantine/core";
import "@mantine/core/styles.css";

import App from "./App";
import "./styles.css";

const theme = createTheme({ primaryColor: "teal" });

const root = document.getElementById("root");

if (!root) throw new Error("Klein Observatory root element is missing");

createRoot(root).render(
  <StrictMode>
    <MantineProvider defaultColorScheme="dark" theme={theme}>
      <App />
    </MantineProvider>
  </StrictMode>,
);
