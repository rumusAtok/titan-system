{{/* Common labels for one workload. Call with (dict "root" $ "name" $name "svc" $svc). */}}
{{- define "titan.labels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/part-of: titan
app.kubernetes.io/version: {{ .root.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .root.Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .root.Chart.Name .root.Chart.Version }}
titan.io/criticality: {{ ternary "critical" "non-critical" (default false .svc.critical) }}
{{- end -}}

{{- define "titan.selectorLabels" -}}
app.kubernetes.io/name: {{ .name }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
{{- end -}}

{{/* Container port by runtime. */}}
{{- define "titan.port" -}}
{{- if eq .runtime "python" -}}8000{{- else if eq .runtime "web" -}}8080{{- else -}}3000{{- end -}}
{{- end -}}

{{/* Numeric user the image runs as, so runAsNonRoot can be verified by the kubelet. */}}
{{- define "titan.uid" -}}
{{- if eq .runtime "python" -}}10001{{- else if eq .runtime "web" -}}101{{- else -}}1000{{- end -}}
{{- end -}}

{{/* Effective replica count of a workload. */}}
{{- define "titan.replicas" -}}
{{- if hasKey .svc "replicas" -}}{{ .svc.replicas }}{{- else -}}{{ .root.Values.defaults.replicas }}{{- end -}}
{{- end -}}

{{/* Short role name used for database users and secrets: "case-service" -> "case". */}}
{{- define "titan.shortName" -}}
{{- . | trimSuffix "-service" | replace "data-pipeline" "pipeline" | replace "ai-gateway" "ai" -}}
{{- end -}}
