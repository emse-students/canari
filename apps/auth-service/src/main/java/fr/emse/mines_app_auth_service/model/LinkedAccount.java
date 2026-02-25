package fr.emse.mines_app_auth_service.model;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "linked_accounts")
public class LinkedAccount {

    @Id
    @GeneratedValue(strategy = GenerationType.UUID)
    private UUID id;

    @Column(nullable = false)
    private String provider; // e.g., "google", "github"

    @Column(nullable = false)
    private String providerId; // The ID from the provider

    private String email; 

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "user_id", nullable = false)
    private User user;

    public LinkedAccount() {}

    public LinkedAccount(String provider, String providerId, String email, User user) {
        this.provider = provider;
        this.providerId = providerId;
        this.email = email;
        this.user = user;
    }

    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getProvider() { return provider; }
    public void setProvider(String provider) { this.provider = provider; }
    public String getProviderId() { return providerId; }
    public void setProviderId(String providerId) { this.providerId = providerId; }
    public String getEmail() { return email; }
    public void setEmail(String email) { this.email = email; }
    public User getUser() { return user; }
    public void setUser(User user) { this.user = user; }
}
