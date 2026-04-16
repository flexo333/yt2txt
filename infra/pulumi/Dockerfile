FROM pulumi/pulumi-python:latest

WORKDIR /infra

COPY requirements.txt .
RUN pip install -r requirements.txt

ENTRYPOINT ["pulumi", "--non-interactive", "--stack", "prod"]
