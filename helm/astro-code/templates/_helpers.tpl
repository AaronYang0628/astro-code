{{/*
Expand the name of the chart.
*/}}
{{- define "astro-code.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "astro-code.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "astro-code.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "astro-code.labels" -}}
helm.sh/chart: {{ include "astro-code.chart" . }}
{{ include "astro-code.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "astro-code.selectorLabels" -}}
app.kubernetes.io/name: {{ include "astro-code.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name
*/}}
{{- define "astro-code.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "astro-code.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
OpenCode config secret name
*/}}
{{- define "astro-code.opencodeConfigSecretName" -}}
{{- if .Values.opencodeConfig.secret.name }}
{{- .Values.opencodeConfig.secret.name }}
{{- else }}
{{- printf "%s-opencode-config" (include "astro-code.fullname" .) }}
{{- end }}
{{- end }}
