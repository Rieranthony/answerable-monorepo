{{/*
One server: its ServiceAccount, Deployment, Service, Ingress, HorizontalPodAutoscaler and PodDisruptionBudget.
Takes root, component (the resource name), image, port, values (its block of values), host, env (rendered variables),
readiness (the readiness path), liveness (an HTTP path, or empty for a TCP check) and clientSecret (the Secret holding its
ID client secret, or empty). Traefik streams responses as they come, which the MCP endpoints' server-sent events need.
A server whose client Secret does not exist yet waits at zero replicas rather than failing to start: the ops register Job
writes the Secret and scales it up (infra/ops/README.md), and the next upgrade, finding the Secret, renders it as usual.
`helm template` has no cluster to look in, so it renders such a server at zero.
*/}}
{{- define "answerable.server" -}}
{{- $root := .root -}}
{{- $values := .values -}}
{{- $scope := dict "root" $root "component" .component -}}
{{- $issuer := $root.Values.ingress.issuer -}}
{{- if not (has $issuer.kind (list "Issuer" "ClusterIssuer")) -}}
{{- fail (printf "ingress.issuer.kind must be Issuer or ClusterIssuer, not %v" $issuer.kind) -}}
{{- end -}}
{{- $waiting := and .clientSecret (not (lookup "v1" "Secret" $root.Release.Namespace .clientSecret)) -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
automountServiceAccountToken: false
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  {{- if $waiting }}
  # Until ops register writes the Secret {{ .clientSecret }} and starts this server.
  replicas: 0
  {{- else if not $values.autoscaling.enabled }}
  replicas: {{ $values.replicas }}
  {{- end }}
  revisionHistoryLimit: 5
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxUnavailable: 0
      maxSurge: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "answerable.labels" $scope | nindent 8 }}
    spec:
      serviceAccountName: {{ .component }}
      automountServiceAccountToken: false
      terminationGracePeriodSeconds: 30
      {{- include "answerable.podCommon" $root | nindent 6 }}
      topologySpreadConstraints:
        - maxSkew: 1
          topologyKey: kubernetes.io/hostname
          whenUnsatisfiable: {{ $root.Values.spreadOverNodes }}
          labelSelector:
            matchLabels:
              {{- include "answerable.selectorLabels" $scope | nindent 14 }}
      containers:
        - name: {{ .component }}
          image: {{ include "answerable.image" (dict "root" $root "name" .image) }}
          imagePullPolicy: {{ $root.Values.image.pullPolicy }}
          ports:
            - name: http
              containerPort: {{ .port }}
          env:
            {{- .env | nindent 12 }}
            {{- include "answerable.commonEnv" $root | nindent 12 }}
            {{- range $name, $value := $values.env }}
            - name: {{ $name }}
              value: {{ $value | quote }}
            {{- end }}
          {{- with .envFrom }}
          envFrom:
            {{- . | nindent 12 }}
          {{- end }}
          startupProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 2
            failureThreshold: 60
          readinessProbe:
            httpGet:
              path: {{ .readiness }}
              port: http
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            {{- if .liveness }}
            httpGet:
              path: {{ .liveness }}
              port: http
            {{- else }}
            tcpSocket:
              port: http
            {{- end }}
            periodSeconds: 10
            failureThreshold: 3
          resources:
            {{- toYaml $values.resources | nindent 12 }}
          securityContext:
            {{- include "answerable.containerSecurityContext" $root | nindent 12 }}
          volumeMounts:
            {{- include "answerable.volumeMounts" $root | nindent 12 }}
---
apiVersion: v1
kind: Service
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  type: ClusterIP
  selector:
    {{- include "answerable.selectorLabels" $scope | nindent 4 }}
  ports:
    - name: http
      port: {{ .port }}
      targetPort: http
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
  annotations:
    cert-manager.io/{{ ternary "cluster-issuer" "issuer" (eq $issuer.kind "ClusterIssuer") }}: {{ $issuer.name }}
    traefik.ingress.kubernetes.io/router.entrypoints: websecure
    traefik.ingress.kubernetes.io/router.tls: "true"
    # Only Cloudflare holds a client certificate the origin-pull CA signed (Authenticated Origin Pulls, D19).
    traefik.ingress.kubernetes.io/router.tls.options: {{ $root.Release.Namespace }}-{{ $root.Values.ingress.tlsOption }}@kubernetescrd
spec:
  ingressClassName: {{ $root.Values.ingress.className }}
  tls:
    - hosts:
        - {{ .host }}
      secretName: {{ .component }}-tls
  rules:
    - host: {{ .host }}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {{ .component }}
                port:
                  name: http
{{- if $values.autoscaling.enabled }}
---
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ .component }}
  minReplicas: {{ $values.autoscaling.minReplicas }}
  maxReplicas: {{ $values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 60
{{- end }}
---
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ .component }}
  labels:
    {{- include "answerable.labels" $scope | nindent 4 }}
spec:
  maxUnavailable: 1
  selector:
    matchLabels:
      {{- include "answerable.selectorLabels" $scope | nindent 6 }}
{{- end -}}
